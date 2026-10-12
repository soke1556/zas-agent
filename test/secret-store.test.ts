import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecrets, removeSecrets, storeSecrets } from '../src/secret-store.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const platform = process.platform;
const secrets = { x25519_private: 'private-x', p256_private: 'private-p', poll_secret: 'poll-test', code: 'secret-code' };
let dir: string | undefined;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const setup = (os: string) => {
  dir = mkdtempSync(join(tmpdir(), 'zas-store-'));
  Object.defineProperty(process, 'platform', { value: os });
  return dir;
};

describe('OS secret store adapters', () => {
  it('passes macOS secrets on stdin, verifies the save, and looks up by reference', () => {
    const at = setup('darwin');
    const encoded = Buffer.from(JSON.stringify(secrets)).toString('base64');
    vi.mocked(execFileSync).mockReturnValue(encoded as never);
    const ref = storeSecrets(at, secrets);
    expect(ref.backend).toBe('keychain');
    const save = vi.mocked(execFileSync).mock.calls[0];
    expect(save[1]).toEqual(['-i']);
    expect((save[2] as { input: string }).input).toContain(encoded);
    expect(loadSecrets(at, ref)).toEqual(secrets);
    removeSecrets(at, ref);
    expect(readdirSync(at)).toEqual([]);
    for (const call of vi.mocked(execFileSync).mock.calls) expect(JSON.stringify(call[1])).not.toContain(encoded);
  });
  it('uses Secret Service when available and keeps private data out of arguments', () => {
    const at = setup('linux');
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/test-bus');
    const encoded = Buffer.from(JSON.stringify(secrets)).toString('base64');
    vi.mocked(execFileSync).mockReturnValue(encoded as never);
    const ref = storeSecrets(at, secrets);
    expect(ref.backend).toBe('secret-service');
    expect(loadSecrets(at, ref)).toEqual(secrets);
    removeSecrets(at, ref);
    for (const call of vi.mocked(execFileSync).mock.calls) expect(JSON.stringify(call[1])).not.toContain(encoded);
  });
  it('never falls back to plaintext or leaks command output when Windows protection fails', () => {
    const at = setup('win32');
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error(JSON.stringify(secrets)); });
    expect(() => storeSecrets(at, secrets)).toThrowError(expect.objectContaining({ code: 'secret_store_failed' }));
    expect(() => storeSecrets(at, secrets)).not.toThrow(/private-x/);
    expect(readdirSync(at)).toEqual([]);
  });
  it('does not silently downgrade an existing unavailable Secret Service reference', () => {
    const at = setup('linux');
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('locked'); });
    expect(() => loadSecrets(at, { backend: 'secret-service', id: '00000000-0000-0000-0000-000000000000' }))
      .toThrowError(expect.objectContaining({ code: 'secret_store_failed' }));
    expect(readdirSync(at)).toEqual([]);
  });
  it.skipIf(platform === 'win32')('uses an owner-only file when no Linux service exists and checks it again on load', async () => {
    const at = setup('linux');
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', '');
    vi.stubEnv('DISPLAY', '');
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not installed'); });
    const ref = storeSecrets(at, secrets);
    expect(ref.backend).toBe('file');
    expect(loadSecrets(at, ref)).toEqual(secrets);
    const { chmodSync, statSync } = await import('node:fs');
    const file = join(at, `secret-${ref.id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toBe('');
    chmodSync(file, 0o644);
    expect(() => loadSecrets(at, ref)).toThrowError(expect.objectContaining({ code: 'identity_permissions' }));
  });
});
