// The Directo job against a fake engine and a fake wire: the offer it seals,
// the wait for a claim, the signals it relays, the state it reports, and the
// fallback it can run afterwards. The engine itself is the web's and has its
// own tests; the production run is the proof that the two fit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64ToBytes, bytesToB64 } from '../src/shared/hash.js';
import { encryptChannelName, openRaw, sealRaw } from '../src/shared/manifest.js';
import { assignChannelKey, mintChannelKey } from '../src/shared/sharedchannel.js';
import type { DirectDiag, SenderOpts, SignalMsg, startSender } from '../src/shared/direct-engine.js';
import type { ZasClient } from '../src/client.js';
import { sendDirect, sendDirectFallback, type DirectDeps, type FailedDirect } from '../src/direct.js';
import { ZasError } from '../src/errors.js';
import { defaultEndpoints, newKeyMaterial, type Identity, type RemoteGrant } from '../src/identity.js';
import type { SendContext } from '../src/send.js';

const keys = newKeyMaterial();
const identity: Identity = {
  version: 1,
  agent_uid: `agent_${'A'.repeat(22)}`,
  owner_uid: 'owner-1',
  name: 'Claude Code',
  kind: 'claude_code',
  host: 'box',
  ...keys,
  ...defaultEndpoints(),
};
const channelKey = mintChannelKey();

function grant(over: Partial<RemoteGrant> = {}): RemoteGrant {
  return {
    channel_id: 'ch1',
    send: true,
    read: false,
    wrapped_key: bytesToB64(assignChannelKey(b64ToBytes(keys.x25519_public), 1, channelKey)),
    key_version: 1,
    name_enc: bytesToB64(encryptChannelName(channelKey, 'Trabajo', 1)),
    mode: 'edit',
    direct_mode: true,
    ...over,
  };
}

const seal = (value: unknown): string =>
  bytesToB64(sealRaw(channelKey, 1, new TextEncoder().encode(JSON.stringify(value))));
const open = (enc: string): unknown =>
  JSON.parse(new TextDecoder().decode(openRaw(channelKey, b64ToBytes(enc))));

/** The wire: the API, the offer document and its signals. `states` is what
 *  each poll of the offer sees, the last one repeating. The receiver answers
 *  the first signal the sender posts. */
function fakeWire(opts: { grants?: RemoteGrant[]; states?: (string | null)[] } = {}) {
  const grants = opts.grants ?? [grant()];
  const states = [...(opts.states ?? ['open', 'claimed'])];
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let answered = false;
  const api = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/agents/me') return { grants };
    if (path === '/direct/ch1') return { id: 'o1' };
    if (path.endsWith('/ice')) return { ice: [{ urls: 'turn:relay.example', username: 'u', credential: 'c' }] };
    if (path.endsWith('/signal')) { answered = true; return { ok: true }; }
    if (path.endsWith('/fallback/parts')) {
      const { from, count } = body as { from: number; count: number };
      return { urls: Array.from({ length: count }, (_, i) => ({ part_number: from + i, url: `https://r2.example/part-${from + i}` })) };
    }
    return { ok: true };
  });
  const firestoreGet = vi.fn(async (path: string) => {
    const state = states.length > 1 ? states.shift() : states[0];
    if (state === null) return null;
    return { name: path, fields: { state: { stringValue: state } } };
  });
  const firestoreRunQuery = vi.fn(async () => (answered
    ? [{ name: 'signals/s1', fields: { for: { stringValue: 'sender' }, payload_enc: { stringValue: seal({ kind: 'answer', sdp: 'v=0 answer' }) } } }]
    : []));
  const client = { identity, api, firestoreGet, firestoreRunQuery } as unknown as ZasClient;
  return { client, calls, firestoreGet, firestoreRunQuery, paths: () => calls.map((c) => `${c.method} ${c.path}`) };
}

/** A sender engine that behaves like the real one from the outside: it talks
 *  first (an offer through `send`), and once it hears an answer it connects,
 *  flies, and ends the way `outcome` says. */
function fakeEngine(outcome: 'done' | 'failed', reason = '', doneAfterMs = 0) {
  const accepted: SignalMsg[] = [];
  let opts: SenderOpts | undefined;
  const engine: typeof startSender = (o) => {
    opts = o;
    void o.send({ kind: 'offer', sdp: 'v=0' });
    return {
      accept: (msg) => {
        accepted.push(msg);
        o.onPhase('flight');
        o.onProgress?.(5, 5);
        o.onPath?.('lan');
        o.onDiag?.({ reason, ms: 12, iceState: 'connected', gatherState: 'complete' } as DirectDiag);
        if (doneAfterMs > 0) setTimeout(() => o.onPhase(outcome), doneAfterMs);
        else o.onPhase(outcome);
      },
      close: () => undefined,
    };
  };
  return { engine, accepted, opts: () => opts };
}

const bytes = new TextEncoder().encode('hello');
const deps = (over: Partial<DirectDeps> = {}): DirectDeps => ({
  installWebRtc: async () => undefined,
  openFile: async (_path, options) => new Blob([bytes], options),
  // A real timer, short: a sleep that resolves in a microtask would starve
  // the engine fake's timers and the heartbeat.
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
  now: () => 1_000,
  device: 'device-token-0001',
  signalPollMs: 0,
  ...over,
});

describe('sendDirect', () => {
  let home = '';
  let ctx: SendContext;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-agent-direct-'));
    process.env.ZAS_AGENT_HOME = home;
  });

  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('offers, waits for the claim, relays both signals sealed, and reports done', async () => {
    const wire = fakeWire();
    ctx = { identity, client: wire.client, profile: 'p' };
    const engine = fakeEngine('done', '', 30);
    const phases: string[] = [];
    const result = await sendDirect(ctx, { path: '/tmp/hello.txt' }, (p) => phases.push(p), deps({ engine: engine.engine, heartbeatMs: 5 }));

    expect(phases).toEqual(['offer', 'connecting', 'flight', 'finishing']);
    expect(result).toEqual({
      offer_id: 'o1', channel_id: 'ch1', channel_name: 'Trabajo', bytes: 5, path: 'lan', duration_ms: 0,
    });

    const offer = wire.calls.find((c) => c.path === '/direct/ch1')!;
    expect(open(offer.body!.meta_enc as string)).toEqual({ name: 'hello.txt', size: 5, mime: 'text/plain' });
    expect(open(offer.body!.sender_label_enc as string)).toBe('Claude Code');
    expect(offer.body).toMatchObject({ key_version: 1, size_bytes: 5, device: 'device-token-0001', owner_uid: 'owner-1' });

    const signal = wire.calls.find((c) => c.path === '/direct/ch1/o1/signal')!;
    expect(signal.body).toMatchObject({ for: 'receiver', device: 'device-token-0001', owner_uid: 'owner-1' });
    expect(open(signal.body!.payload_enc as string)).toEqual({ kind: 'offer', sdp: 'v=0' });
    expect(engine.accepted).toEqual([{ kind: 'answer', sdp: 'v=0 answer' }]);

    // TURN reached the engine next to the built-in STUN list, and the label
    // is the agent's name, what the receiving row shows as "from".
    expect(engine.opts()!.ice!.some((s) => String(s.urls).startsWith('turn:'))).toBe(true);
    expect(engine.opts()!.label).toBe('Claude Code');

    // The engine builds its own meta frame from the file it was handed, and
    // the receiver stops a transfer whose frame does not match the offer
    // above. Both readings come from one file, so the type has to be on it.
    expect(engine.opts()!.file.type).toBe('text/plain');

    expect(wire.calls.find((c) => c.path === '/direct/ch1/o1/state')!.body).toMatchObject({ state: 'done' });
    expect(wire.paths().filter((p) => p.endsWith('/heartbeat')).length).toBeGreaterThan(0);
    expect(wire.firestoreGet).toHaveBeenCalledWith('accounts/owner-1/channels/ch1/direct/o1');
    expect(wire.paths().filter((p) => !p.endsWith('/heartbeat'))).toEqual([
      'GET /agents/me', 'POST /direct/ch1', 'POST /direct/ch1/o1/ice', 'POST /direct/ch1/o1/signal', 'POST /direct/ch1/o1/state',
    ]);
  });

  it('reports failed with the engine reason, and hands the run to the fallback', async () => {
    const wire = fakeWire();
    ctx = { identity, client: wire.client, profile: 'p' };
    const engine = fakeEngine('failed', 'ice_failed');
    let record: FailedDirect | undefined;
    const error = await sendDirect(ctx, { path: '/tmp/hello.txt' }, () => undefined, deps({ engine: engine.engine, onFailed: (r) => { record = r; } }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZasError);
    expect((error as ZasError).code).toBe('direct_failed');
    expect((error as ZasError).message).toBe('ice_failed');
    expect(wire.calls.find((c) => c.path === '/direct/ch1/o1/state')!.body).toMatchObject({ state: 'failed' });
    expect(record).toMatchObject({
      channel_id: 'ch1', channel_name: 'Trabajo', offer_id: 'o1', owner_uid: 'owner-1', device: 'device-token-0001',
      path: '/tmp/hello.txt', name: 'hello.txt', size: 5, key_version: 1, reason: 'ice_failed',
    });
    expect(bytesToB64(record!.key)).toBe(bytesToB64(channelKey));
  });

  it('withdraws an offer nobody claimed in time, before any engine runs', async () => {
    const wire = fakeWire({ states: ['open'] });
    ctx = { identity, client: wire.client, profile: 'p' };
    const engine = fakeEngine('done');
    await expect(sendDirect(ctx, { path: '/tmp/hello.txt' }, () => undefined, deps({ engine: engine.engine, offerWaitMs: 0 })))
      .rejects.toMatchObject({ code: 'not_claimed' });
    expect(wire.calls.find((c) => c.path === '/direct/ch1/o1/state')!.body).toMatchObject({ state: 'cancelled' });
    expect(engine.opts()).toBeUndefined();
  });

  it('reports an offer the other side cancelled, or that is gone', async () => {
    for (const states of [['cancelled'], [null]] as (string | null)[][]) {
      const wire = fakeWire({ states });
      ctx = { identity, client: wire.client, profile: 'p' };
      await expect(sendDirect(ctx, { path: '/tmp/hello.txt' }, () => undefined, deps({ engine: fakeEngine('done').engine })))
        .rejects.toMatchObject({ code: 'direct_cancelled' });
      expect(wire.paths()).not.toContain('POST /direct/ch1/o1/ice');
    }
  });

  it('refuses before the offer when the grant or the mode says no', async () => {
    const cases: [Partial<RemoteGrant>, string][] = [
      [{ direct_mode: false }, 'not_direct_mode'],
      [{ send: false }, 'send_forbidden'],
      [{ mode: 'view' }, 'send_forbidden'],
    ];
    for (const [over, code] of cases) {
      const wire = fakeWire({ grants: [grant(over)] });
      // One profile per case: the grants cache lives under the profile.
      ctx = { identity, client: wire.client, profile: `p-${code}-${Object.keys(over)[0]}` };
      await expect(sendDirect(ctx, { path: '/tmp/hello.txt' }, () => undefined, deps())).rejects.toMatchObject({ code });
      expect(wire.paths()).toEqual(['GET /agents/me']);
    }
  });

  it('answers a path it cannot open with the send vocabulary', async () => {
    const wire = fakeWire();
    ctx = { identity, client: wire.client, profile: 'p' };
    await expect(sendDirect(ctx, { path: '/nowhere/x.bin' }, () => undefined, deps({ openFile: async () => { throw new Error('ENOENT'); } })))
      .rejects.toMatchObject({ code: 'upload_failed' });
    expect(wire.paths()).toEqual(['GET /agents/me']);
  });
});

describe('sendDirectFallback', () => {
  const record: FailedDirect = {
    channel_id: 'ch1', channel_name: 'Trabajo', offer_id: 'o1', owner_uid: 'owner-1', device: 'device-token-0001',
    path: '/tmp/hello.txt', name: 'hello.txt', size: 5, key: channelKey, key_version: 1, reason: 'ice_failed',
  };

  it('encrypts the file in parts, uploads them through the injected transport, and completes', async () => {
    const wire = fakeWire();
    const ctx: SendContext = { identity, client: wire.client, profile: 'p' };
    const puts: { url: string; length: number }[] = [];
    const phases: string[] = [];
    const result = await sendDirectFallback(ctx, record, (p) => phases.push(p), deps({
      put: async (url, chunk, _signal, onLoaded) => { puts.push({ url, length: chunk.length }); onLoaded(chunk.length); return 'etag-1'; },
    }));
    expect(phases).toEqual(['encrypting', 'uploading', 'finishing']);
    expect(result).toEqual({ offer_id: 'o1', channel_id: 'ch1', channel_name: 'Trabajo', bytes: 5, duration_ms: 0, parts: 1 });
    expect(wire.paths()).toEqual([
      'POST /direct/ch1/o1/fallback/start', 'POST /direct/ch1/o1/fallback/parts', 'POST /direct/ch1/o1/fallback/complete',
    ]);
    const start = wire.calls[0].body!;
    expect(start).toMatchObject({ plain_size: 5, cipher_size: 21, part_count: 1, device: 'device-token-0001', owner_uid: 'owner-1' });
    expect(open(start.meta_enc as string)).toMatchObject({ v: 1, name: 'hello.txt', size: 5, mime: 'text/plain', part_count: 1, cipher_size: 21 });
    expect(puts).toEqual([{ url: 'https://r2.example/part-1', length: 21 }]);
    expect(wire.calls[2].body).toMatchObject({ parts: [{ part_number: 1, etag: 'etag-1' }], device: 'device-token-0001' });
  });

  it('aborts the upload on the server when the parts cannot be put', async () => {
    const wire = fakeWire();
    const ctx: SendContext = { identity, client: wire.client, profile: 'p' };
    await expect(sendDirectFallback(ctx, record, () => undefined, deps({
      put: async () => { throw new Error('fallback_put_503'); },
    }))).rejects.toMatchObject({ code: 'upload_failed' });
    expect(wire.paths().at(-1)).toBe('POST /direct/ch1/o1/fallback/abort');
  });

  it('refuses a file that changed since the offer, before any call', async () => {
    const wire = fakeWire();
    const ctx: SendContext = { identity, client: wire.client, profile: 'p' };
    await expect(sendDirectFallback(ctx, record, () => undefined, deps({ openFile: async () => new Blob([new Uint8Array(6)]) })))
      .rejects.toMatchObject({ code: 'file_changed' });
    expect(wire.paths()).toEqual([]);
  });
});
