import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultEndpoints, newKeyMaterial, type Identity } from '../src/identity.js';
import { apiPublic, ZasClient } from '../src/client.js';
import { main } from '../src/cli.js';

afterEach(() => vi.unstubAllEnvs());
const identity = (): Identity => ({ version: 1, agent_uid: 'a', owner_uid: 'o', name: 'test', kind: 'codex', host: 'box', ...newKeyMaterial(), ...defaultEndpoints() });
const demo = () => {
  vi.stubEnv('ZAS_ALLOW_INSECURE_DEV', '1');
  vi.stubEnv('ZAS_API_BASE', 'http://127.0.0.1:5001/api');
  vi.stubEnv('ZAS_TOKEN_BASE', 'http://localhost:5001/token');
  vi.stubEnv('ZAS_OPRF_BASE', 'http://[::1]:5001/oprf');
  vi.stubEnv('ZAS_FIREBASE_PROJECT', 'demo-zas');
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099');
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '[::1]:8080');
};

describe('credential transport boundaries', () => {
  it.each(['http://example.com', 'http://localhost', 'ftp://zas.red', 'https://user:pass@zas.red', 'https://zas.red/#fragment'])('rejects unsafe base %s at startup', async (url) => {
    vi.stubEnv('ZAS_API_BASE', url);
    const log = vi.fn();
    expect(await main([], log)).toBe(1);
    expect(log.mock.calls.flat().join(' ')).toContain('Unsafe endpoint');
  });

  it.each(['10.0.0.5:8080', 'localhost.example:8080', '127.0.0.1:8080/path', 'localhost:8080'])('rejects emulator host without explicit dev configuration: %s', (host) => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', host);
    expect(defaultEndpoints).toThrowError(expect.objectContaining({ code: 'unsafe_endpoint' }));
  });

  it('allows the isolated loopback demo and sends only its locally minted tokens', async () => {
    demo();
    const wire = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(path).hostname);
      expect(init?.redirect).toBe('error');
      if (path.endsWith('/challenge')) return Response.json({ challenge_id: 'c', nonce: Buffer.alloc(32, 1).toString('base64') });
      if (path.endsWith('/token')) return Response.json({ token: 'demo-custom' });
      if (path.includes('signInWithCustomToken')) {
        expect(JSON.parse(String(init?.body)).token).toBe('demo-custom');
        return Response.json({ idToken: 'demo-id', expiresIn: '3600' });
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer demo-id');
      return Response.json([]);
    });
    const client = new ZasClient(identity(), { fetch: wire });
    expect(await client.firestoreRunQuery('', {})).toEqual([]);
    expect(wire).toHaveBeenCalledTimes(4);
  });

  it('never exchanges a production custom token or sends a production bearer to an emulator', async () => {
    const prod = identity();
    const wire = vi.fn();
    const client = new ZasClient(prod, { fetch: wire });
    demo();
    await expect(client.signIn()).rejects.toMatchObject({ code: 'unsafe_endpoint' });
    await expect(client.firestoreGet('anything')).rejects.toMatchObject({ code: 'unsafe_endpoint' });
    expect(wire).not.toHaveBeenCalled();
  });

  it('refuses LAN HTTP even with the dev flag and rejects public-call redirects', async () => {
    demo();
    vi.stubEnv('ZAS_API_BASE', 'http://10.0.0.5');
    expect(defaultEndpoints).toThrowError(expect.objectContaining({ code: 'unsafe_endpoint' }));
    const wire = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      return Response.json({ ok: true });
    });
    await apiPublic('https://zas.red/api', 'POST', '/pair', { poll_secret: 'test' }, {}, wire);
  });
});
