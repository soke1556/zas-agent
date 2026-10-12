import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  clearPending, defaultEndpoints, loadFingerprints, loadGrants, loadIdentity, loadPending, newKeyMaterial, profileDir,
  saveGrants, saveIdentity, savePending, type Identity, type Pending,
} from '../src/identity.js';
import { removeSecrets } from '../src/secret-store.js';
import { ZasError } from '../src/errors.js';
import { b64ToBytes } from '../src/shared/hash.js';
import { assignChannelKey, openChannelAssignment } from '../src/shared/sharedchannel.js';
import { signAgentChallenge, verifyAgentChallenge } from '../src/shared/agent.js';

describe('identity files', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'zas-agent-')); process.env.ZAS_AGENT_HOME = home; });
  afterEach(() => {
    for (const profile of readdirSync(home, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue;
      const dir = join(home, profile.name);
      for (const file of ['identity.json', 'pending.json']) {
        try {
          const stored = JSON.parse(readFileSync(join(dir, file), 'utf8'));
          if (stored.secret_ref) removeSecrets(dir, stored.secret_ref);
        } catch { /* malformed or absent fixture */ }
      }
    }
    delete process.env.ZAS_AGENT_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('mints X25519 and P-256 material of the right sizes', () => {
    const k = newKeyMaterial();
    expect(b64ToBytes(k.x25519_public)).toHaveLength(32);
    expect(b64ToBytes(k.x25519_private)).toHaveLength(32);
    expect(b64ToBytes(k.p256_public)).toHaveLength(65);
    expect(b64ToBytes(k.p256_private)).toHaveLength(32);
  });

  it('round-trips an identity under the profile directory, private to the user', () => {
    const identity: Identity = { version: 1, agent_uid: 'agent_' + 'A'.repeat(22), owner_uid: 'o', name: 'CC', kind: 'claude_code', host: 'box', ...newKeyMaterial(), ...defaultEndpoints() };
    expect(loadIdentity('claude-code')).toBeNull();
    saveIdentity('claude-code', identity);
    expect(profileDir('claude-code')).toBe(join(home, 'claude-code'));
    expect(loadIdentity('claude-code')).toEqual(identity);
    if (process.platform !== 'win32') {
      expect(statSync(join(home, 'claude-code', 'identity.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'claude-code')).mode & 0o777).toBe(0o700);
    }
    const stored = JSON.parse(readFileSync(join(home, 'claude-code', 'identity.json'), 'utf8'));
    expect(stored.version).toBe(1);
    expect(stored).not.toHaveProperty('x25519_private');
    expect(stored).not.toHaveProperty('p256_private');
    expect(stored.secret_ref.backend).toBeDefined();
  }, 30_000);

  it('refuses a profile name that is not a directory name under the agent home', () => {
    // The CLI validates `--profile`, but the library entry is reachable
    // without it, and every read and write goes through this one join.
    for (const bad of ['..', '.', '.hidden', 'a/b', 'a\\b', '', 'x'.repeat(65), 'ñ']) {
      expect(() => profileDir(bad), bad).toThrow(ZasError);
    }
    expect(() => profileDir('..')).toThrow(/profile/i);
    for (const good of ['claude-code', 'codex', 'mi-agente', 'a.b_c-1', 'x'.repeat(64)]) {
      expect(profileDir(good), good).toBe(join(home, good));
    }
  });

  it('migrates legacy keys before use and still signs challenges and unwraps channel keys', () => {
    const identity: Identity = { version: 1, agent_uid: 'agent_' + 'A'.repeat(22), owner_uid: 'o', name: 'CC', kind: 'codex', host: 'box', ...newKeyMaterial(), ...defaultEndpoints() };
    const dir = profileDir('legacy');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'identity.json');
    writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
    const loaded = loadIdentity('legacy')!;
    expect(loaded).toEqual(identity);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored).not.toHaveProperty('x25519_private');
    expect(stored).not.toHaveProperty('p256_private');
    expect(stored.secret_ref).toBeDefined();
    if (process.platform === 'win32') {
      expect(stored.secret_ref.backend).toBe('dpapi');
      const encrypted = readFileSync(join(dir, `secret-${stored.secret_ref.id}.json`), 'utf8');
      expect(Buffer.from(encrypted, 'base64').includes(Buffer.from(identity.p256_private))).toBe(false);
      // Use .NET directly: pwsh parents can pass a PSModulePath that prevents
      // Windows PowerShell from importing the module that contains Get-Acl.
      const aclCheck = "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $a=[IO.Directory]::GetAccessControl($p); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
        + "$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); "
        + "[Console]::Out.Write(($a.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid))";
      expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', aclCheck],
        { input: dir, encoding: 'utf8', windowsHide: true }).trim()).toBe('True');
    }
    const nonce = new Uint8Array(32).fill(7);
    const signature = signAgentChallenge(b64ToBytes(loaded.p256_private), loaded.agent_uid, 'challenge', nonce);
    expect(verifyAgentChallenge(b64ToBytes(loaded.p256_public), signature, loaded.agent_uid, 'challenge', nonce)).toBe(true);
    const channelKey = new Uint8Array(32).fill(9);
    for (const format of [1, 2] as const) {
      const envelope = assignChannelKey(b64ToBytes(loaded.x25519_public), 1, channelKey, format);
      expect(openChannelAssignment(b64ToBytes(loaded.x25519_private), envelope)).toEqual(channelKey);
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('refuses a 0644 legacy secret before migration and gives a chmod command', () => {
    const dir = profileDir('insecure');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'identity.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    expect(() => loadIdentity('insecure')).toThrowError(expect.objectContaining({ code: 'identity_permissions' }));
    expect(() => loadIdentity('insecure')).toThrow(/chmod 600/);
    expect(readFileSync(file, 'utf8')).toBe('{}');
  });

  it('refuses unsafe saved endpoints before loading or migrating any key material', () => {
    const dir = profileDir('unsafe');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'identity.json');
    const stored = { ...defaultEndpoints(), api_base: 'http://example.com' };
    writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    expect(() => loadIdentity('unsafe')).toThrowError(expect.objectContaining({ code: 'unsafe_endpoint' }));
    expect(readdirSync(dir)).toEqual(['identity.json']);
  });

  it('keeps a grants cache beside the identity, stamped with the agent that filled it', () => {
    const agent_uid = `agent_${'A'.repeat(22)}`;
    expect(loadGrants('p')).toBeNull();
    saveGrants('p', { fetched_at: 5, agent_uid, grants: [] });
    expect(loadGrants('p')).toEqual({ fetched_at: 5, agent_uid, grants: [] });
  });

  it('keeps a pending pairing until it is cleared', () => {
    const pending: Pending = {
      version: 1, profile: 'p', pairing_id: 'pr1', poll_secret: 's1', code: '123456', fingerprint: 'ff'.repeat(32),
      expires_at: 1_000, kind: 'codex', host: 'box', ...newKeyMaterial(), ...defaultEndpoints(), created_at: 900,
    };
    expect(loadPending('p')).toBeNull();
    savePending('p', pending);
    expect(loadPending('p')).toEqual(pending);
    clearPending('p');
    expect(loadPending('p')).toBeNull();
    expect(() => clearPending('p')).not.toThrow();
  }, 30_000);

  it('refuses a damaged identity file instead of reading it as never paired', () => {
    const dir = profileDir('broken');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'identity.json');
    writeFileSync(file, '{ not json', { mode: 0o600 });
    let thrown: unknown;
    try { loadIdentity('broken'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(ZasError);
    expect((thrown as ZasError).code).toBe('identity_corrupt');
    expect((thrown as ZasError).message).toContain(file);
    // Absent still means "never paired", which is the whole distinction.
    expect(loadIdentity('never-paired')).toBeNull();
  });

  it('refuses a damaged pending file, but shrugs off a damaged cache', () => {
    const dir = profileDir('broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending.json'), 'null', { mode: 0o600 });
    expect(() => loadPending('broken')).toThrowError(expect.objectContaining({ code: 'identity_corrupt' }));
    writeFileSync(join(dir, 'grants.json'), '{ not json');
    writeFileSync(join(dir, 'fingerprints.json'), '{ not json');
    expect(loadGrants('broken')).toBeNull();
    expect(loadFingerprints('broken')).toEqual({ entries: {} });
  });

  it('reads endpoints from the environment with production defaults', () => {
    expect(defaultEndpoints().api_base).toBe('https://zas.red/api');
    process.env.ZAS_ALLOW_INSECURE_DEV = '1';
    process.env.ZAS_API_BASE = 'http://127.0.0.1:1/v1';
    expect(defaultEndpoints().api_base).toBe('http://127.0.0.1:1/v1');
    delete process.env.ZAS_API_BASE;
    delete process.env.ZAS_ALLOW_INSECURE_DEV;
  });
});
