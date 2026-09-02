import { describe, expect, it, vi } from 'vitest';
import { ZasClient } from '../src/client.js';
import { ZasError } from '../src/errors.js';
import { newKeyMaterial, defaultEndpoints, type Identity } from '../src/identity.js';
import { verifyAgentChallenge } from '../src/shared/agent.js';
import { b64ToBytes } from '../src/shared/hash.js';

const keys = newKeyMaterial();
const identity: Identity = { version: 1, agent_uid: 'agent_' + 'A'.repeat(22), owner_uid: 'owner-1', name: 'CC', kind: 'claude_code', host: 'box', ...keys, ...defaultEndpoints() };

function fakeFetch(log: string[], opts: { evaluate401?: 'once' | 'always' } = {}) {
  let now = 1_000_000;
  let evaluate401 = opts.evaluate401 !== undefined;
  return {
    now: () => now,
    tick: (ms: number) => { now += ms; },
    fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      log.push(`${init?.method ?? 'GET'} ${url}`);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/v1/agents/challenge')) return json(200, { challenge_id: 'ch1', nonce: Buffer.alloc(32, 3).toString('base64'), expires_at: now + 60_000 });
      if (url.endsWith('/v1/agents/token')) {
        const ok = verifyAgentChallenge(b64ToBytes(keys.p256_public), b64ToBytes(body.signature), body.agent_uid, body.challenge_id, Buffer.alloc(32, 3));
        return ok ? json(200, { token: 'custom-1', expires_in: 3600 }) : json(403, { error: 'bad_signature' });
      }
      if (url.includes('accounts:signInWithCustomToken')) return json(200, { idToken: 'id-1', refreshToken: 'r-1', expiresIn: '3600' });
      if (url.endsWith('/v1/agents/me')) return init?.headers && (init.headers as Record<string, string>).Authorization === 'Bearer id-1' ? json(200, { agent_uid: identity.agent_uid }) : json(401, { error: 'invalid_token' });
      if (url.endsWith('/v1/links')) return json(403, { error: 'read_only' });
      if (url.endsWith('/evaluate')) {
        if (evaluate401) {
          if (opts.evaluate401 === 'once') evaluate401 = false;
          return json(401, { error: 'invalid_token' });
        }
        return json(200, { evaluated: ['e1', 'e2'] });
      }
      return json(404, { error: 'not_found' });
    }),
  };
}

describe('ZasClient', () => {
  it('signs in with a valid challenge signature and reuses the token until it nears expiry', async () => {
    const log: string[] = [];
    const f = fakeFetch(log);
    const client = new ZasClient(identity, { fetch: f.fetch, now: f.now });
    expect(await client.api('GET', '/agents/me')).toEqual({ agent_uid: identity.agent_uid });
    expect(log.filter((l) => l.includes('/agents/challenge'))).toHaveLength(1);
    await client.api('GET', '/agents/me');
    expect(log.filter((l) => l.includes('/agents/challenge'))).toHaveLength(1);
    f.tick(56 * 60_000);
    await client.api('GET', '/agents/me');
    expect(log.filter((l) => l.includes('/agents/challenge'))).toHaveLength(2);
  });

  it('maps server errors into the closed set', async () => {
    const f = fakeFetch([]);
    const client = new ZasClient(identity, { fetch: f.fetch, now: f.now });
    await expect(client.api('POST', '/links', {})).rejects.toMatchObject({ code: 'send_forbidden', status: 403 } satisfies Partial<ZasError>);
  });

  it('signs in again once when the OPRF service rejects the token, and answers', async () => {
    // The OPRF call is the first thing a send makes, and it is the one that
    // meets a token revoked between the refresh margin and the call. Without
    // the retry the whole send dies on an auth error the client can fix.
    const log: string[] = [];
    const f = fakeFetch(log, { evaluate401: 'once' });
    const client = new ZasClient(identity, { fetch: f.fetch, now: f.now });
    expect(await client.oprfEvaluate(['b1', 'b2'])).toEqual(['e1', 'e2']);
    expect(log.filter((l) => l.includes('/agents/challenge'))).toHaveLength(2);
    expect(log.filter((l) => l.endsWith('/evaluate'))).toHaveLength(2);
  });

  it('gives up after one OPRF retry rather than looping on a token it cannot fix', async () => {
    const log: string[] = [];
    const f = fakeFetch(log, { evaluate401: 'always' });
    const client = new ZasClient(identity, { fetch: f.fetch, now: f.now });
    await expect(client.oprfEvaluate(['b1'])).rejects.toMatchObject({ status: 401 } satisfies Partial<ZasError>);
    expect(log.filter((l) => l.endsWith('/evaluate'))).toHaveLength(2);
  });
});
