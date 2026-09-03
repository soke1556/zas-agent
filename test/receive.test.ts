// The Directo receive against a fake engine and a fake wire: the offer it
// waits for, the claim it makes, the signals it relays, the file it writes,
// and the fallback download that can still finish a run that broke. The engine
// itself is the web's and has its own tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64ToBytes, bytesToB64 } from '../src/shared/hash.js';
import { encryptChannelName, openRaw, sealRaw } from '../src/shared/manifest.js';
import { assignChannelKey, mintChannelKey } from '../src/shared/sharedchannel.js';
import { DIRECT_FILE_MAX_BYTES } from '../src/shared/direct.js';
import { createFallbackMeta, uploadFallback } from '../src/shared/direct-fallback.js';
import type { DirectDiag, ReceiverOpts, SignalMsg, startReceiver } from '../src/shared/direct-engine.js';
import type { DirectMeta } from '../src/shared/direct-protocol.js';
import type { ZasClient } from '../src/client.js';
import { ZasError } from '../src/errors.js';
import { defaultEndpoints, newKeyMaterial, type Identity, type RemoteGrant } from '../src/identity.js';
import { receiveDirect, receiveDirectFallback, type FailedReceive, type ReceiveDeps } from '../src/receive.js';
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
const otherKey = mintChannelKey();

function grant(over: Partial<RemoteGrant> = {}): RemoteGrant {
  return {
    channel_id: 'ch1',
    send: false,
    read: true,
    wrapped_key: bytesToB64(assignChannelKey(b64ToBytes(keys.x25519_public), 1, channelKey)),
    key_version: 1,
    name_enc: bytesToB64(encryptChannelName(channelKey, 'Trabajo', 1)),
    mode: 'edit',
    direct_mode: true,
    ...over,
  };
}

const sealWith = (key: Uint8Array, value: unknown): string =>
  bytesToB64(sealRaw(key, 1, new TextEncoder().encode(JSON.stringify(value))));
const seal = (value: unknown): string => sealWith(channelKey, value);
const open = (enc: string): unknown =>
  JSON.parse(new TextDecoder().decode(openRaw(channelKey, b64ToBytes(enc))));

const payload = new TextEncoder().encode('hola directo');
const offered: DirectMeta = { name: 'nota.txt', size: payload.length, mime: 'text/plain' };

const docPath = (id: string) =>
  `projects/zas/databases/(default)/documents/accounts/owner-1/channels/ch1/direct/${id}`;

interface OfferRow { id?: string; state?: string; sender?: string; metaEnc?: string }

/** One row of the channel's `direct` collection, in the REST shape. */
function offerRow(over: OfferRow = {}) {
  const fields: Record<string, { stringValue: string }> = {
    state: { stringValue: over.state ?? 'open' },
    sender: { stringValue: over.sender ?? 'owner-1' },
  };
  const enc = over.metaEnc ?? seal(offered);
  if (enc !== '') fields.meta_enc = { stringValue: enc };
  return { name: docPath(over.id ?? 'o1'), fields };
}

/** The wire: the API, the channel's offers and the offer's signals. The sender
 *  speaks first, so the signal poll always has an offer to hand the engine. */
function fakeWire(opts: {
  grants?: RemoteGrant[];
  offers?: ReturnType<typeof offerRow>[][];
  claim?: () => never;
  offerDoc?: Record<string, { stringValue: string }>;
  download?: string;
} = {}) {
  const grants = opts.grants ?? [grant()];
  const pages = [...(opts.offers ?? [[offerRow()]])];
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const api = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/agents/me') return { grants };
    if (path.endsWith('/claim')) { opts.claim?.(); return { ok: true }; }
    if (path.endsWith('/ice')) return { ice: [{ urls: 'turn:relay.example', username: 'u', credential: 'c' }] };
    if (path.endsWith('/fallback/download')) return { url: opts.download ?? 'https://r2.example/copy' };
    return { ok: true };
  });
  const firestoreGet = vi.fn(async (path: string) => (
    opts.offerDoc ? { name: path, fields: opts.offerDoc } : null
  ));
  const firestoreRunQuery = vi.fn(async (parent: string) => {
    if (parent.includes('/direct/')) {
      return [{
        name: 'signals/s1',
        fields: {
          for: { stringValue: 'receiver' },
          payload_enc: { stringValue: seal({ kind: 'offer', sdp: 'v=0' }) },
        },
      }];
    }
    return pages.length > 1 ? pages.shift()! : pages[0];
  });
  const client = { identity, api, firestoreGet, firestoreRunQuery } as unknown as ZasClient;
  return { client, calls, api, firestoreGet, paths: () => calls.map((c) => `${c.method} ${c.path}`) };
}

/** A receiver engine that behaves like the real one from the outside: it hears
 *  the sender's offer, answers, opens the sink, and ends the way `outcome`
 *  says — writing everything first, or a partial it then discards. */
function fakeEngine(outcome: 'done' | 'failed', reason = 'ice_failed') {
  const accepted: SignalMsg[] = [];
  let seen: ReceiverOpts | undefined;
  const engine: typeof startReceiver = (o) => {
    seen = o;
    return {
      accept: (msg) => {
        accepted.push(msg);
        void (async () => {
          await o.send({ kind: 'answer', sdp: 'v=0 answer' });
          // The real engine turns a sink it cannot open into a failed run, and
          // never lets the rejection escape.
          let sink;
          try {
            sink = await o.sink(o.expectedMeta ?? offered);
          } catch {
            o.onDiag?.({ reason: 'sink', ms: 1, iceState: 'connected', gatherState: 'complete' } as DirectDiag);
            o.onPhase('failed');
            return;
          }
          o.onPhase('flight');
          o.onPath?.('lan');
          if (outcome === 'done') {
            await sink.write(payload);
            await sink.close();
            o.onDiag?.({ reason: '', ms: 12, iceState: 'connected', gatherState: 'complete' } as DirectDiag);
          } else {
            await sink.write(payload.subarray(0, 4));
            sink.abort?.();
            o.onDiag?.({ reason, ms: 12, iceState: 'failed', gatherState: 'complete' } as DirectDiag);
          }
          o.onPhase(outcome);
        })();
      },
      close: () => undefined,
    };
  };
  return { engine, accepted, opts: () => seen };
}

const deps = (over: Partial<ReceiveDeps> = {}): ReceiveDeps => ({
  installWebRtc: async () => undefined,
  // A real timer, short: a sleep that resolves in a microtask would starve the
  // engine fake's own timers.
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
  now: () => 1_000,
  device: 'device-token-0001',
  signalPollMs: 0,
  offerPollMs: 0,
  ...over,
});

describe('receiveDirect', () => {
  let home = '';
  let dest = '';
  let profile = '';
  let seq = 0;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-agent-recv-'));
    dest = mkdtempSync(join(tmpdir(), 'zas-agent-dest-'));
    process.env.ZAS_AGENT_HOME = home;
    // One profile per case: the grants cache lives under the profile directory
    // and holds for a minute.
    profile = `p-${seq++}`;
  });

  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  const ctxOf = (client: ZasClient): SendContext => ({ identity, client, profile });

  it('waits for an offer, claims it, relays the answer sealed, and writes the file', async () => {
    const wire = fakeWire();
    const engine = fakeEngine('done');
    const phases: string[] = [];
    const result = await receiveDirect(
      ctxOf(wire.client), { channel: 'ch1', dest }, (p) => phases.push(p), deps({ engine: engine.engine }),
    );

    expect(phases).toEqual(['waiting', 'connecting', 'flight', 'finishing']);
    expect(result).toMatchObject({
      offer_id: 'o1', channel_id: 'ch1', channel_name: 'Trabajo', name: 'nota.txt',
      bytes: payload.length, via: 'lan',
    });
    expect(result.path).toBe(join(dest, 'nota.txt'));
    expect(readFileSync(result.path)).toEqual(Buffer.from(payload));

    // The claim carries this job's device token and the plaintext size the
    // server cannot read for itself.
    const claim = wire.calls.find((c) => c.path.endsWith('/claim'));
    expect(claim?.body).toEqual({ device: 'device-token-0001', owner_uid: 'owner-1', size_bytes: payload.length });
    // The engine's answer goes back sealed, addressed to the sender.
    const signal = wire.calls.find((c) => c.path.endsWith('/signal'));
    expect(signal?.body).toMatchObject({ for: 'sender', device: 'device-token-0001' });
    expect(open(signal!.body!.payload_enc as string)).toEqual({ kind: 'answer', sdp: 'v=0 answer' });
    expect(engine.accepted).toEqual([{ kind: 'offer', sdp: 'v=0' }]);
    expect(engine.opts()?.expectedMeta).toEqual(offered);
    // And the run is reported, so the sender's screen says it arrived.
    expect(wire.calls.find((c) => c.path.endsWith('/state'))?.body)
      .toEqual({ state: 'done', device: 'device-token-0001', owner_uid: 'owner-1' });
  });

  it('never overwrites: a name already taken steps aside', async () => {
    const wire = fakeWire();
    await receiveDirect(ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined, deps({ engine: fakeEngine('done').engine }));
    const again = fakeWire();
    const result = await receiveDirect(
      ctxOf(again.client), { channel: 'ch1', dest }, () => undefined, deps({ engine: fakeEngine('done').engine }),
    );
    expect(result.path).toBe(join(dest, 'nota (1).txt'));
    expect(readdirSync(dest).sort()).toEqual(['nota (1).txt', 'nota.txt']);
  });

  it('refuses without a read grant, and off Directo', async () => {
    for (const [over, code] of [
      [{ read: false }, 'read_forbidden'],
      [{ direct_mode: false }, 'not_direct_mode'],
    ] as [Partial<RemoteGrant>, string][]) {
      profile = `p-${code}`;
      const wire = fakeWire({ grants: [grant(over)] });
      await expect(receiveDirect(ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined, deps()))
        .rejects.toMatchObject({ code });
      expect(wire.paths()).not.toContain('POST /direct/ch1/o1/claim');
    }
  });

  it('answers no_offer when nothing is offered while it waits', async () => {
    const wire = fakeWire({ offers: [[]] });
    await expect(receiveDirect(ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined, deps({ offerWaitMs: 0 })))
      .rejects.toBeInstanceOf(ZasError);
    await expect(receiveDirect(ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined, deps({ offerWaitMs: 0 })))
      .rejects.toMatchObject({ code: 'no_offer' });
  });

  it('skips a row it must not take: its own offer, a claimed one, and another key’s seal', async () => {
    const wire = fakeWire({
      offers: [[
        offerRow({ id: 'mine', sender: identity.agent_uid }),
        offerRow({ id: 'gone', state: 'claimed' }),
        offerRow({ id: 'theirs', metaEnc: sealWith(otherKey, offered) }),
      ]],
    });
    await expect(receiveDirect(ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined, deps({ offerWaitMs: 0 })))
      .rejects.toMatchObject({ code: 'no_offer' });
    expect(wire.paths().filter((p) => p.endsWith('/claim'))).toEqual([]);
  });

  it('refuses a file over the Directo ceiling before it claims', async () => {
    const wire = fakeWire({ offers: [[offerRow({ metaEnc: seal({ ...offered, size: DIRECT_FILE_MAX_BYTES + 1 }) })]] });
    await expect(receiveDirect(ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined, deps()))
      .rejects.toMatchObject({ code: 'file_too_big' });
    expect(wire.paths().filter((p) => p.endsWith('/claim'))).toEqual([]);
  });

  it('answers offer_taken when another device claimed first', async () => {
    const wire = fakeWire({
      claim: () => { throw new ZasError('upload_failed', 409, 'claimed', undefined, 'claimed'); },
    });
    await expect(receiveDirect(ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined, deps()))
      .rejects.toMatchObject({ code: 'offer_taken' });
  });

  it('reports a failed run, keeps nothing on disk, and hands the record to the fallback', async () => {
    const wire = fakeWire({ offerDoc: { state: { stringValue: 'failed' } } });
    const failures: FailedReceive[] = [];
    await expect(receiveDirect(
      ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined,
      deps({ engine: fakeEngine('failed', 'ice_failed').engine, onFailed: (r) => failures.push(r) }),
    )).rejects.toMatchObject({ code: 'direct_failed', message: 'ice_failed' });

    expect(readdirSync(dest)).toEqual([]);
    expect(wire.calls.find((c) => c.path.endsWith('/state'))?.body).toMatchObject({ state: 'failed' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      channel_id: 'ch1', channel_name: 'Trabajo', offer_id: 'o1', owner_uid: 'owner-1',
      device: 'device-token-0001', dest, meta: offered, key_version: 1, reason: 'ice_failed',
    });
  });

  it('calls a withdrawn offer cancelled, not failed', async () => {
    const wire = fakeWire({ offerDoc: { state: { stringValue: 'cancelled' } } });
    const failures: FailedReceive[] = [];
    await expect(receiveDirect(
      ctxOf(wire.client), { channel: 'ch1', dest }, () => undefined,
      deps({ engine: fakeEngine('failed').engine, onFailed: (r) => failures.push(r) }),
    )).rejects.toMatchObject({ code: 'direct_cancelled' });
    // Nothing to deliver later: the sender is gone.
    expect(failures).toEqual([]);
  });

  it('answers write_failed when the destination cannot be written', async () => {
    const wire = fakeWire({ offerDoc: { state: { stringValue: 'failed' } } });
    // A file standing where the destination's parent directory would go.
    writeFileSync(join(dest, 'blocker.txt'), 'no');
    await expect(receiveDirect(
      ctxOf(wire.client), { channel: 'ch1', dest: join(dest, 'blocker.txt', 'deeper') }, () => undefined,
      deps({ engine: fakeEngine('done').engine }),
    )).rejects.toMatchObject({ code: 'write_failed' });
  });
});

describe('receiveDirectFallback', () => {
  let home = '';
  let dest = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-agent-recvfb-'));
    dest = mkdtempSync(join(tmpdir(), 'zas-agent-fbdest-'));
    process.env.ZAS_AGENT_HOME = home;
  });

  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  const record = (over: Partial<FailedReceive> = {}): FailedReceive => ({
    channel_id: 'ch1',
    channel_name: 'Trabajo',
    offer_id: 'o1',
    owner_uid: 'owner-1',
    device: 'device-token-0001',
    dest,
    meta: offered,
    key: channelKey,
    key_version: 1,
    reason: 'ice_failed',
    ...over,
  });

  /** The encrypted copy the sender uploaded, produced by the same code that
   *  uploads it, so the download is decrypting real ciphertext. */
  async function storedCopy() {
    const file = new File([payload], offered.name, { type: offered.mime });
    const meta = createFallbackMeta(file);
    const parts: Uint8Array[] = [];
    await uploadFallback({
      file,
      offerId: 'o1',
      meta,
      put: async (_url, bytes) => { parts.push(new Uint8Array(bytes)); return '"etag"'; },
      getUrls: async (from, count) => Array.from({ length: count }, (_, i) => ({ part_number: from + i, url: `https://r2.example/${from + i}` })),
    });
    const cipher = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) { cipher.set(part, at); at += part.length; }
    return { meta, cipher };
  }

  it('downloads the stored copy, decrypts it to disk and reports the receipt', async () => {
    const copy = await storedCopy();
    const wire = fakeWire({ offerDoc: { fallback_meta_enc: { stringValue: seal(copy.meta) } } });
    const phases: string[] = [];
    const result = await receiveDirectFallback(
      { identity, client: wire.client, profile: 'fb-1' }, record(), (p) => phases.push(p),
      { now: () => 1_000, fetcher: (async () => new Response(copy.cipher)) as unknown as typeof fetch },
    );
    expect(phases).toEqual(['downloading', 'finishing']);
    expect(result).toMatchObject({ offer_id: 'o1', name: 'nota.txt', bytes: payload.length });
    expect(readFileSync(result.path)).toEqual(Buffer.from(payload));
    expect(wire.paths()).toContain('POST /direct/ch1/o1/fallback/received');
  });

  it('refuses a copy of a different file, and an offer with no copy at all', async () => {
    const copy = await storedCopy();
    const wire = fakeWire({ offerDoc: { fallback_meta_enc: { stringValue: seal(copy.meta) } } });
    await expect(receiveDirectFallback(
      { identity, client: wire.client, profile: 'fb-2' }, record({ meta: { ...offered, size: 9 } }), () => undefined, {},
    )).rejects.toMatchObject({ code: 'file_changed' });

    const bare = fakeWire({ offerDoc: { state: { stringValue: 'failed' } } });
    await expect(receiveDirectFallback(
      { identity, client: bare.client, profile: 'fb-3' }, record(), () => undefined, {},
    )).rejects.toMatchObject({ code: 'fallback_unavailable' });
    expect(readdirSync(dest)).toEqual([]);
  });

  it('leaves nothing behind when the download breaks', async () => {
    const copy = await storedCopy();
    const wire = fakeWire({ offerDoc: { fallback_meta_enc: { stringValue: seal(copy.meta) } } });
    await expect(receiveDirectFallback(
      { identity, client: wire.client, profile: 'fb-4' }, record(), () => undefined,
      { fetcher: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch },
    )).rejects.toBeInstanceOf(ZasError);
    expect(readdirSync(dest)).toEqual([]);
    expect(existsSync(join(dest, 'nota.txt'))).toBe(false);
    expect(wire.paths()).not.toContain('POST /direct/ch1/o1/fallback/received');
  });
});
