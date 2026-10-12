import { describe, expect, it, vi } from 'vitest';
import { placeFile, type SendContext } from '../src/send.js';
import { newKeyMaterial, defaultEndpoints, type Identity } from '../src/identity.js';
import { ZasClient } from '../src/client.js';
import { b64ToBytes, bytesToB64 } from '../src/shared/hash.js';
import { voprfEvaluate, voprfPublicKey } from '../src/shared/voprf.js';
import { ZasError } from '../src/errors.js';

const identity: Identity = { version: 1, agent_uid: 'a', owner_uid: 'o', name: 'test', kind: 'codex', host: 'box', ...newKeyMaterial(), ...defaultEndpoints() };
describe('send security refusals before blob placement', () => {
  it('rejects identity OPRF replies before probing or uploading chunks', async () => {
    const api = vi.fn();
    const client = {
      api, dedupePolicy: async () => ({ mode: 0 }),
      oprfEvaluate: async (points: string[]) => points.map(() => bytesToB64(new Uint8Array(32))),
    } as unknown as ZasClient;
    await expect(placeFile({ identity, client, profile: 'test' }, new TextEncoder().encode('file')))
      .rejects.toMatchObject({ code: 'oprf_failed' });
    expect(api).not.toHaveBeenCalled();
  });

  it('uses the server-selected VOPRF mode and refuses a wrong proof without a base-mode retry or blob writes', async () => {
    const policy = { mode: 1 as const, keyId: 'test', publicKey: voprfPublicKey(7n) };
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = new ZasClient(identity, { fetch: (async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}'));
      calls.push({ url, body });
      if (url.endsWith('/challenge')) return Response.json({ challenge_id: 'c', nonce: bytesToB64(new Uint8Array(32).fill(1)) });
      if (url.endsWith('/token')) return Response.json({ token: 'custom' });
      if (url.includes('signInWithCustomToken')) return Response.json({ idToken: 'id', expiresIn: '3600' });
      if (url.endsWith('/evaluate')) {
        const result = voprfEvaluate(8n, body.blinded.map(b64ToBytes));
        return Response.json({ mode: 1, key_id: 'test', evaluated: result.evaluated.map(bytesToB64), proof: bytesToB64(result.proof) });
      }
      throw new Error('Unexpected network request');
    }) as typeof fetch });
    vi.spyOn(client, 'dedupePolicy').mockResolvedValue(policy);
    const api = vi.spyOn(client, 'api');
    const ctx: SendContext = { identity, client, profile: 'test' };
    await expect(placeFile(ctx, new TextEncoder().encode('proof test'))).rejects.toMatchObject({ code: 'invalid_voprf_proof' });
    const evaluated = calls.filter(({ url }) => url.endsWith('/evaluate'));
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0].body).toMatchObject({ mode: 1, key_id: 'test' });
    expect(api).not.toHaveBeenCalled();
  });

  it('stops on missing pins before evaluating or writing blobs', async () => {
    const api = vi.fn();
    const oprfEvaluate = vi.fn();
    const client = { api, oprfEvaluate, dedupePolicy: async () => { throw new ZasError('invalid_voprf_configuration', 0); } } as unknown as ZasClient;
    await expect(placeFile({ identity, client, profile: 'test' }, new Uint8Array([1])))
      .rejects.toMatchObject({ code: 'invalid_voprf_configuration' });
    expect(api).not.toHaveBeenCalled();
    expect(oprfEvaluate).not.toHaveBeenCalled();
  });
});
