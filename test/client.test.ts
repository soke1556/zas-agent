import { describe, expect, it, vi } from 'vitest';
import { apiPublic, ZasClient } from '../src/client.js';
import { ZasError } from '../src/errors.js';
import { newKeyMaterial, defaultEndpoints, type Identity } from '../src/identity.js';
import { verifyAgentChallenge } from '../src/shared/agent.js';
import { b64ToBytes } from '../src/shared/hash.js';
import { bytesToB64 } from '../src/shared/hash.js';
import { voprfBlind, voprfEvaluate, voprfPublicKey } from '../src/shared/voprf.js';

const keys = newKeyMaterial();
const identity: Identity = { version: 1, agent_uid: 'agent_' + 'A'.repeat(22), owner_uid: 'owner-1', name: 'CC', kind: 'claude_code', host: 'box', ...keys, ...defaultEndpoints() };

it('cancels an in-flight upload API request without retrying it', async () => {
  const wire = fakeFetch([]);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const client = new ZasClient(identity, { fetch: async (url, init) => {
    if (!String(url).endsWith('/upload-url')) return wire.fetch(url, init);
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      started();
    });
  } });
  const pending = client.api('POST', '/blobs/blob/upload-url', {}, {}, controller.signal);
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await ready;
  controller.abort();
  await assertion;
  expect(calls).toBe(1);
});

it('bounds authentication and metadata requests with timeout signals', async () => {
  const wire = fakeFetch([]);
  const signals: AbortSignal[] = [];
  const client = new ZasClient(identity, { fetch: async (url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    signals.push(init!.signal!);
    return wire.fetch(url, init);
  } });
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    await client.api('GET', '/agents/me');
    expect(signals).toHaveLength(4);
    expect(timeout.mock.calls).toEqual(Array(4).fill([30_000]));
  } finally { timeout.mockRestore(); }
});

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
  it('gets the selected mode from its allowed agent route and requires a local pin', async () => {
    const wire = fakeFetch([]);
    const paths: string[] = [];
    const client = new ZasClient(identity, { now: wire.now, fetch: (async (url, init) => {
      paths.push(String(url));
      if (String(url).endsWith('/agents/me')) return new Response(JSON.stringify({ dedupe: { mode: 1, key_id: 'test' } }));
      return wire.fetch(url, init);
    }) as typeof fetch });
    vi.stubEnv('ZAS_VOPRF_PUBLIC_KEYS', '{}');
    try {
      await expect(client.dedupePolicy()).rejects.toMatchObject({ code: 'invalid_voprf_configuration' });
      const publicKey = voprfPublicKey(7n);
      vi.stubEnv('ZAS_VOPRF_PUBLIC_KEYS', JSON.stringify({ test: bytesToB64(publicKey) }));
      expect(await client.dedupePolicy()).toEqual({ mode: 1, keyId: 'test', publicKey });
      expect(paths.some((path) => path.endsWith('/capabilities'))).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it('pins the VOPRF key and rejects a service-selected key without retrying in base mode', async () => {
    const wire = fakeFetch([]);
    let wrong = false;
    const requests: Record<string, unknown>[] = [];
    const client = new ZasClient(identity, { now: wire.now, fetch: (async (url, init) => {
      if (!String(url).endsWith('/evaluate')) return wire.fetch(url, init);
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const result = voprfEvaluate(wrong ? 8n : 7n, body.blinded.map(b64ToBytes));
      return new Response(JSON.stringify({ mode: 1, key_id: 'test', evaluated: result.evaluated.map(bytesToB64), proof: bytesToB64(result.proof), public_key: bytesToB64(result.publicKey) }), { status: 200 });
    }) as typeof fetch });
    const policy = { mode: 1 as const, keyId: 'test', publicKey: voprfPublicKey(7n) };
    const blinded = [bytesToB64(voprfBlind(new TextEncoder().encode('file')).blindedElement)];
    expect(await client.oprfEvaluate(blinded, policy)).toHaveLength(1);
    wrong = true;
    await expect(client.oprfEvaluate(blinded, policy)).rejects.toMatchObject({ code: 'invalid_voprf_proof' });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.mode === 1 && request.key_id === 'test')).toBe(true);
  });
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

it('telemetry never signs in, refreshes on a refusal, or starts concurrent requests', async () => {
  const log: string[] = [];
  const wire = fakeFetch(log);
  let resolveReport!: (res: Response) => void;
  const report = vi.fn(() => new Promise<Response>(resolve => { resolveReport = resolve; }));
  const client = new ZasClient(identity, { now: wire.now, fetch: ((url, init) =>
    String(url).endsWith('/agents/telemetry') ? report() : wire.fetch(url, init)) as typeof fetch });
  await client.reportTelemetry({events:[]});
  expect(log).toEqual([]); expect(report).not.toHaveBeenCalled();
  await client.idToken();
  const authCalls = log.length;
  const pending = client.reportTelemetry({events:[]});
  await client.reportTelemetry({events:[]});
  expect(report).toHaveBeenCalledOnce();
  resolveReport(new Response(null,{status:401})); await pending;
  expect(log).toHaveLength(authCalls);
  wire.tick(3600000);
  await client.reportTelemetry({events:[]});
  expect(log).toHaveLength(authCalls); expect(report).toHaveBeenCalledOnce();
});


it.each(['fetch', 'body'])('reports a timeout during %s as a network failure', async (phase) => {
  const wire = fakeFetch([]);
  const failingFetch: typeof fetch = async () => {
    const error = new DOMException('Timed out', 'TimeoutError');
    if (phase === 'fetch') throw error;
    return new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
  };
  await expect(apiPublic(identity.api_base, 'GET', '/test', undefined, {}, failingFetch))
    .rejects.toMatchObject({ code: 'network' });
  const client = new ZasClient(identity, { fetch: async (url, init) => {
    if (String(url).endsWith('/agents/me')) return failingFetch(url, init);
    return wire.fetch(url, init);
  } });
  await expect(client.api('GET', '/agents/me')).rejects.toMatchObject({ code: 'network' });
});
