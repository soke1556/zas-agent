// Pairing tests exercise the protocol without opening a desktop keychain.
// Native storage and migration are covered separately in identity.test.ts.
import { vi } from 'vitest';
vi.mock('../../src/secret-store.js', async (original) => {
  const actual = await original<typeof import('../../src/secret-store.js')>();
  const secrets = new Map<string, Record<string, string>>();
  let sequence = 0;
  return {
    ...actual,
    storeSecrets: (_dir: string, value: Record<string, string>) => {
      const id = `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
      secrets.set(id, { ...value });
      return { backend: process.platform === 'win32' ? 'dpapi' : 'file', id };
    },
    loadSecrets: (_dir: string, ref: { id: string }) => {
      const value = secrets.get(ref.id);
      if (!value) throw new Error('missing test secret');
      return { ...value };
    },
    removeSecrets: (_dir: string, ref: { id: string }) => { secrets.delete(ref.id); },
  };
});
