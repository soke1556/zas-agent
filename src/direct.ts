// Directo from this process. The engine is the web app's, unchanged
// (shared/src/direct-engine.ts); this file adds the wiring a browser tab does
// in Main.tsx: the offer through the API, the wait for a claim, TURN, sealed
// signals both ways, the heartbeat, and the final state. Two things differ
// from a tab. The WebRTC classes come from node-datachannel, installed as
// globals the first time a Directo send runs. And the offer and its signals
// are polled through Firestore REST rather than streamed: a poll every 400 ms
// is well inside the engine's clocks, and it needs no SDK in the bundle.
import { randomBytes } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { b64ToBytes, bytesToB64 } from './shared/hash.js';
import { openRaw, sealRaw } from './shared/manifest.js';
import { DIRECT_FILE_MAX_BYTES } from './shared/direct.js';
import {
  DIRECT_ICE,
  startSender,
  type DirectDiag,
  type DirectPath,
  type SignalMsg,
} from './shared/direct-engine.js';
import type { DirectMeta } from './shared/direct-protocol.js';
import { createFallbackMeta, uploadFallback, type PutPart } from './shared/direct-fallback.js';
import { ZasError } from './errors.js';
import { channelKeyOf, channelNameOf, grantsFor, resolveChannel } from './grants.js';
import type { RemoteGrant } from './identity.js';
import { mimeFor, type SendContext, type SendPhase } from './send.js';

/** What a Directo job reports while it runs. `offer` is the wait for somebody
 *  to press Receive; the rest are the engine's own phases. */
export type DirectJobPhase = 'offer' | 'connecting' | 'flight' | 'finishing';

export interface DirectInput { path: string; channel?: string }

export interface DirectResult {
  offer_id: string;
  channel_id: string;
  channel_name: string;
  bytes: number;
  /** The route the bytes took, when the engine could tell. */
  path?: DirectPath;
  duration_ms: number;
  /** A fallback delivery: how many encrypted parts were uploaded. */
  parts?: number;
}

/** Everything a fallback needs from the run that failed: the offer the
 *  server will attach the encrypted copy to, the device token that proves
 *  this process is that offer's sender, and the channel key that seals the
 *  layout record. Held in memory only, by the server, for as long as the job
 *  list remembers the job. */
export interface FailedDirect {
  channel_id: string;
  channel_name: string;
  offer_id: string;
  owner_uid: string;
  device: string;
  path: string;
  name: string;
  size: number;
  key: Uint8Array;
  key_version: number;
  reason: string;
}

/** Injection points, all with production defaults. Tests drive the engine,
 *  the file and the clocks; nothing else sets them. */
export interface DirectDeps {
  engine?: typeof startSender;
  installWebRtc?: () => Promise<void>;
  openFile?: (path: string) => Promise<Blob>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long an offer waits for a claim. The server's offer lease. */
  offerWaitMs?: number;
  offerPollMs?: number;
  signalPollMs?: number;
  heartbeatMs?: number;
  put?: PutPart;
  device?: string;
  /** Called with the failed run's record right before `direct_failed` is
   *  thrown, so the caller can offer the fallback for it. */
  onFailed?: (record: FailedDirect) => void;
}

/** The offer lease (functions: `directLeaseMs('open')`), minus a margin so
 *  the agent withdraws the offer before the sweep does. */
const OFFER_WAIT_MS = 9.5 * 60 * 1000;
const OFFER_POLL_MS = 1000;
const SIGNAL_POLL_MS = 400;
/** The web tab's cadence. The claimed lease is hours; this only proves the
 *  sender is still there. */
const HEARTBEAT_MS = 4 * 60 * 1000;

const SIGNALS_FOR_SENDER = {
  from: [{ collectionId: 'signals' }],
  where: { fieldFilter: { field: { fieldPath: 'for' }, op: 'EQUAL', value: { stringValue: 'sender' } } },
};

interface FirestoreDoc { name?: string; fields?: Record<string, { stringValue?: string }> }

const stringField = (doc: unknown, key: string): string | undefined =>
  (doc as FirestoreDoc | null)?.fields?.[key]?.stringValue;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The web's `deviceToken()`: sixteen random bytes, URL-safe. */
const newDeviceToken = (): string => randomBytes(16).toString('base64url');

let webrtc: Promise<void> | null = null;

/** node-datachannel's W3C classes, as the globals the engine expects. Loaded
 *  on the first Directo send rather than at start-up: the native binary is
 *  the one thing in this package that can be missing on a machine, and a
 *  missing binary must fail the send, never the server. */
export function installWebRtc(): Promise<void> {
  if (!webrtc) {
    webrtc = import('node-datachannel/polyfill').then((poly) => {
      const g = globalThis as Record<string, unknown>;
      g.RTCPeerConnection ??= poly.RTCPeerConnection;
      g.RTCIceCandidate ??= poly.RTCIceCandidate;
      g.RTCSessionDescription ??= poly.RTCSessionDescription;
      g.RTCDataChannel ??= poly.RTCDataChannel;
    }, (error: unknown) => {
      webrtc = null;
      throw new ZasError('webrtc_unavailable', 0, String(error));
    });
  }
  return webrtc;
}

/** The grant the caller meant, for a Directo send: it has to allow sending
 *  and the channel has to be in Directo mode. The mode is the person's
 *  switch; an agent never flips it, so a storage channel is a refusal here
 *  and at the server. */
async function directGrantFor(ctx: SendContext, channel: string | undefined): Promise<RemoteGrant> {
  const grant = resolveChannel(ctx.identity, await grantsFor(ctx.client, ctx.profile), channel);
  if (!grant.send || grant.mode === 'view') throw new ZasError('send_forbidden', 403);
  if (!grant.direct_mode) throw new ZasError('not_direct_mode', 409);
  return grant;
}

function nameOf(ctx: SendContext, grant: RemoteGrant): string {
  try {
    return channelNameOf(ctx.identity, grant);
  } catch {
    return grant.channel_id;
  }
}

/** The sealing the web does in `sealDirect`/`openDirect`: JSON under the
 *  channel key, the generation stamped so a receiver on an older key knows. */
function sealer(key: Uint8Array, keyVersion: number) {
  return {
    seal: (value: unknown): string =>
      bytesToB64(sealRaw(key, keyVersion, new TextEncoder().encode(JSON.stringify(value)))),
    open: (enc: string): unknown =>
      JSON.parse(new TextDecoder().decode(openRaw(key, b64ToBytes(enc)))),
  };
}

export async function sendDirect(
  ctx: SendContext,
  input: DirectInput,
  report: (phase: DirectJobPhase) => void,
  deps: DirectDeps = {},
): Promise<DirectResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const grant = await directGrantFor(ctx, input.channel);
  const key = channelKeyOf(ctx.identity, grant);
  const channelName = nameOf(ctx, grant);
  // A path this agent cannot open is one answer whatever the errno: the
  // caller named it, and a raw Node error is not a sentence.
  const file = await (deps.openFile ?? openAsBlob)(input.path).catch(() => {
    throw new ZasError('upload_failed', 400);
  });
  if (file.size > DIRECT_FILE_MAX_BYTES) throw new ZasError('file_too_big', 413);
  const name = basename(input.path);
  const cid = grant.channel_id;
  const owner = ctx.identity.owner_uid;
  const device = deps.device ?? newDeviceToken();
  const { seal, open } = sealer(key, grant.key_version);
  const stamp = { device, owner_uid: owner };
  const startedAt = now();

  report('offer');
  const meta: DirectMeta = { name, size: file.size, mime: mimeFor(input.path) };
  const { id } = await ctx.client.api<{ id: string }>('POST', `/direct/${cid}`, {
    meta_enc: seal(meta),
    key_version: grant.key_version,
    sender_label_enc: seal(ctx.identity.name),
    size_bytes: file.size,
    ...stamp,
  });
  const route = `/direct/${cid}/${id}`;
  const offerPath = `accounts/${owner}/channels/${cid}/direct/${id}`;
  // Best effort: the offer's lease ends it anyway, and a state the server
  // refused is one it already knows.
  const setState = (state: 'done' | 'failed' | 'cancelled'): Promise<void> =>
    ctx.client.api('POST', `${route}/state`, { state, ...stamp }).then(() => undefined, () => undefined);

  // ---- the wait for a claim ----
  const claimBy = startedAt + (deps.offerWaitMs ?? OFFER_WAIT_MS);
  for (;;) {
    const doc = await ctx.client.firestoreGet(offerPath);
    const state = doc === null ? 'cancelled' : (stringField(doc, 'state') ?? 'open');
    if (state === 'claimed') break;
    if (state !== 'open') throw new ZasError('direct_cancelled', 0);
    if (now() >= claimBy) {
      await setState('cancelled');
      throw new ZasError('not_claimed', 0);
    }
    await sleep(deps.offerPollMs ?? OFFER_POLL_MS);
  }

  // ---- the engine ----
  await (deps.installWebRtc ?? installWebRtc)();
  const fetchIce = async (): Promise<RTCIceServer[]> => {
    try {
      const r = await ctx.client.api<{ ice?: RTCIceServer[] }>('POST', `${route}/ice`, stamp);
      return Array.isArray(r.ice) ? r.ice : [];
    } catch {
      // The engine's own STUN list still stands; a LAN pair needs nothing more.
      return [];
    }
  };
  const turn = await fetchIce();
  report('connecting');
  let resolveOutcome!: (phase: 'done' | 'failed') => void;
  const outcome = new Promise<'done' | 'failed'>((resolve) => { resolveOutcome = resolve; });
  let diag: DirectDiag | undefined;
  let path: DirectPath | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const handle = (deps.engine ?? startSender)({
    file,
    name,
    label: ctx.identity.name,
    ice: [...DIRECT_ICE, ...turn],
    refreshIce: async () => [...DIRECT_ICE, ...(await fetchIce())],
    send: (msg: SignalMsg) =>
      ctx.client.api('POST', `${route}/signal`, { payload_enc: seal(msg), for: 'receiver', ...stamp }).then(() => undefined),
    onPhase: (phase) => {
      if (phase === 'flight') {
        report('flight');
        heartbeat ??= setInterval(() => {
          void ctx.client.api('POST', `${route}/heartbeat`, stamp).catch(() => undefined);
        }, deps.heartbeatMs ?? HEARTBEAT_MS);
      }
      if (phase === 'done' || phase === 'failed') resolveOutcome(phase);
    },
    onPath: (p) => { path = p; },
    onDiag: (d) => { diag = d; },
  });

  // ---- the receiver's signals, polled until the engine ends ----
  let over = false;
  const pump = (async () => {
    const seen = new Set<string>();
    while (!over) {
      let rows: unknown[] = [];
      try {
        rows = await ctx.client.firestoreRunQuery(offerPath, SIGNALS_FOR_SENDER);
      } catch {
        /* the next poll asks again; the engine's clocks decide when it is too late */
      }
      for (const row of rows as FirestoreDoc[]) {
        if (!row?.name || seen.has(row.name)) continue;
        seen.add(row.name);
        const enc = stringField(row, 'payload_enc');
        if (!enc) continue;
        try {
          handle.accept(open(enc) as SignalMsg);
        } catch {
          /* another generation's seal, or not a signal: nothing to feed */
        }
      }
      if (!over) await Promise.race([outcome, sleep(deps.signalPollMs ?? SIGNAL_POLL_MS)]);
    }
  })();
  const phase = await outcome;
  over = true;
  clearInterval(heartbeat);
  await pump;

  report('finishing');
  if (phase === 'done') {
    await setState('done');
    return {
      offer_id: id, channel_id: cid, channel_name: channelName, bytes: file.size,
      ...(path ? { path } : {}), duration_ms: now() - startedAt,
    };
  }
  await setState('failed');
  const reason = diag?.reason || 'unknown';
  deps.onFailed?.({
    channel_id: cid, channel_name: channelName, offer_id: id, owner_uid: owner, device,
    path: input.path, name, size: file.size, key, key_version: grant.key_version, reason,
  });
  throw new ZasError('direct_failed', 0, reason);
}

/** One part's PUT with fetch. No progress events, which the web's XHR gives
 *  and a job phase does not need. */
export const fetchPut: PutPart = async (url, bytes, signal, onLoaded) => {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const res = await fetch(url, { method: 'PUT', body, signal });
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new Error(`fallback_put_${res.status}`);
  const etag = res.headers.get('etag');
  if (!etag) throw new Error('fallback_etag_missing');
  onLoaded(bytes.length);
  return etag;
};

/** The reliable-delivery path for a run that failed in flight: the web's
 *  "Entregar aunque se desconecten", from the same offer, as the same
 *  device. The file is encrypted in parts on this machine and only the
 *  ciphertext is stored, for one day. */
export async function sendDirectFallback(
  ctx: SendContext,
  record: FailedDirect,
  report: (phase: SendPhase) => void,
  deps: DirectDeps = {},
): Promise<DirectResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const opened = await (deps.openFile ?? openAsBlob)(record.path).catch(() => {
    throw new ZasError('upload_failed', 400);
  });
  // The offer named a size; a file that changed since is a different file,
  // and the receiver would open something the person never offered.
  if (opened.size !== record.size) throw new ZasError('file_changed', 0);
  const file = new File([opened], record.name, { type: mimeFor(record.path) });
  const { seal } = sealer(record.key, record.key_version);
  const stamp = { device: record.device, owner_uid: record.owner_uid };
  const base = `/direct/${record.channel_id}/${record.offer_id}/fallback`;

  report('encrypting');
  const meta = createFallbackMeta(file);
  await ctx.client.api('POST', `${base}/start`, {
    meta_enc: seal(meta),
    plain_size: meta.size,
    cipher_size: meta.cipher_size,
    part_count: meta.part_count,
    ...stamp,
  });
  report('uploading');
  let parts: { partNumber: number; etag: string }[];
  try {
    parts = await uploadFallback({
      file,
      offerId: record.offer_id,
      meta,
      put: deps.put ?? fetchPut,
      getUrls: async (from, count) => {
        const r = await ctx.client.api<{ urls: { part_number: number; url: string }[] }>(
          'POST', `${base}/parts`, { from, count, ...stamp },
        );
        return r.urls;
      },
    });
  } catch (error) {
    // Frees the multipart upload on the server side; a retry starts clean.
    await ctx.client.api('POST', `${base}/abort`, stamp).catch(() => undefined);
    if (error instanceof ZasError) throw error;
    throw new ZasError('upload_failed', 0, error instanceof Error ? error.message : String(error));
  }
  report('finishing');
  await ctx.client.api('POST', `${base}/complete`, {
    parts: parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
    ...stamp,
  });
  return {
    offer_id: record.offer_id,
    channel_id: record.channel_id,
    channel_name: record.channel_name,
    bytes: record.size,
    duration_ms: now() - startedAt,
    parts: parts.length,
  };
}
