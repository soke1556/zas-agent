import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearPending, defaultEndpoints, loadFingerprints, loadGrants, loadIdentity, loadPending, newKeyMaterial, profileDir,
  saveGrants, saveIdentity, savePending, type Identity, type Pending,
} from '../src/identity.js';
import { ZasError } from '../src/errors.js';
import { b64ToBytes } from '../src/shared/hash.js';

describe('identity files', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'zas-agent-')); process.env.ZAS_AGENT_HOME = home; });
  afterEach(() => { delete process.env.ZAS_AGENT_HOME; rmSync(home, { recursive: true, force: true }); });

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
    expect(JSON.parse(readFileSync(join(home, 'claude-code', 'identity.json'), 'utf8')).version).toBe(1);
  });

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
  });

  it('refuses a damaged identity file instead of reading it as never paired', () => {
    const dir = profileDir('broken');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'identity.json');
    writeFileSync(file, '{ not json');
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
    writeFileSync(join(dir, 'pending.json'), 'null');
    expect(() => loadPending('broken')).toThrowError(expect.objectContaining({ code: 'identity_corrupt' }));
    writeFileSync(join(dir, 'grants.json'), '{ not json');
    writeFileSync(join(dir, 'fingerprints.json'), '{ not json');
    expect(loadGrants('broken')).toBeNull();
    expect(loadFingerprints('broken')).toEqual({ entries: {} });
  });

  it('reads endpoints from the environment with production defaults', () => {
    expect(defaultEndpoints().api_base).toBe('https://zas.red/api');
    process.env.ZAS_API_BASE = 'http://127.0.0.1:1/v1';
    expect(defaultEndpoints().api_base).toBe('http://127.0.0.1:1/v1');
    delete process.env.ZAS_API_BASE;
  });
});
