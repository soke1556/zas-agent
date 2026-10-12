import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultEndpoints, loadIdentity, newKeyMaterial, profileDir } from '../src/identity.js';

vi.mock('../src/secret-store.js', async (original) => {
  const actual = await original<typeof import('../src/secret-store.js')>();
  const { ZasError } = await import('../src/errors.js');
  return { ...actual, storeSecrets: () => { throw new ZasError('secret_store_failed', 0); } };
});
let home: string;
afterEach(() => { vi.unstubAllEnvs(); if (home) rmSync(home, { recursive: true, force: true }); });
it('preserves the recoverable legacy file when migration cannot save to the OS store', () => {
  home = mkdtempSync(join(tmpdir(), 'zas-migrate-failure-'));
  vi.stubEnv('ZAS_AGENT_HOME', home);
  const dir = profileDir('p');
  mkdirSync(dir, { mode: 0o700 });
  const before = JSON.stringify({ version: 1, ...defaultEndpoints(), ...newKeyMaterial() });
  const file = join(dir, 'identity.json');
  writeFileSync(file, before, { mode: 0o600 });
  expect(() => loadIdentity('p')).toThrowError(expect.objectContaining({ code: 'secret_store_failed' }));
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(readdirSync(dir)).toEqual(['identity.json']);
});
