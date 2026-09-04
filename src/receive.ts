// Directo into this machine. The mirror of `direct.ts` — the same engine, the
// same sealed signals polled through Firestore REST, the same per-job device
// token — pointed the other way. What is new is the wait for somebody else's
// offer, the claim that takes it, and a sink that writes to disk.
//
// Claiming is an act, never a watch. An exchange takes two devices and the
// first claim wins, so an agent that subscribed to its channels would quietly
// take files meant for the person's own phone. This runs because a tool call
// asked it to, and it stops when the call ends.
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DIRECT_FILE_MAX_BYTES } from './shared/direct.js';
import {
  DIRECT_ICE,
  startReceiver,
  type DirectDiag,
  type DirectPath,
  type SignalMsg,
  type Sink,
} from './shared/direct-engine.js';
import { downloadFallback, fallbackMetaOf, type DirectFallbackMeta } from './shared/direct-fallback.js';
import type { DirectMeta } from './shared/direct-protocol.js';
import { channelLabel, defaultSleep, installWebRtc, newDeviceToken, sealer } from './direct.js';
import { ZasError } from './errors.js';
import { channelKeyOf, grantsFor, resolveChannel } from './grants.js';
import type { RemoteGrant } from './identity.js';
import { destinationOf } from './read.js';
import type { SendContext } from './send.js';

/** What a receive reports while it runs. `waiting` is the wait for somebody to
 *  press Send Direct; the rest are the engine's own phases, plus the fallback
 *  download. */
export type ReceiveJobPhase = 'waiting' | 'connecting' | 'flight' | 'downloading' | 'finishing';

export interface ReceiveInput {
  channel?: string;
  /** Where to write the file. A directory means "inside it". Absent is a
   *  private temporary directory, as in `zas_get_item`. */
  dest?: string;
}

export interface ReceiveResult {
  offer_id: string;
  channel_id: string;
  channel_name: string;
  name: string;
  bytes: number;
  /** Where the bytes actually went. It differs from `dest` when something was
   *  already standing there. */
  path: string;
  /** The route the bytes took, when the engine could tell. */
  via?: DirectPath;
  duration_ms: number;
}

/** Everything a fallback download needs from the run that failed: the offer
 *  the encrypted copy hangs under, the device token that proves this process
 *  claimed it, and the channel key that opens the layout record. Held in
 *  memory only, by the server, for as long as the job list remembers the job. */
export interface FailedReceive {
  channel_id: string;
  channel_name: string;
  offer_id: string;
  owner_uid: string;
  device: string;
  dest?: string;
  meta: DirectMeta;
  key: Uint8Array;
  key_version: number;
  reason: string;
}

/** Injection points, all with production defaults. Tests drive the engine and
 *  the clocks; nothing else sets them. */
export interface ReceiveDeps {
  engine?: typeof startReceiver;
  installWebRtc?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long the tool waits for an offer to appear. */
  offerWaitMs?: number;
  offerPollMs?: number;
  signalPollMs?: number;
  device?: string;
  fetcher?: typeof fetch;
  /** Called with the failed run's record right before `direct_failed` is
   *  thrown, so the caller can offer the fallback for it. */
  onFailed?: (record: FailedReceive) => void;
  /** Called with the engine's own account of the run, done or failed. The
   *  job record carries it so `zas_jobs` can answer "why" and not only
   *  "which word" — the reason alone has never been enough to act on. */
  onDiag?: (diag: DirectDiag) => void;
}

/** The offer lease (functions: `directLeaseMs('open')`), minus a margin: an
 *  offer this end takes in its last second would be swept mid-handshake. */
const OFFER_WAIT_MS = 9.5 * 60 * 1000;
const OFFER_POLL_MS = 1000;
const SIGNAL_POLL_MS = 400;
/** How many offers one poll looks at. A channel holds a handful of live
 *  offers at most; the rest of the page would be expired rows. */
const OFFER_PAGE = 10;

/** Newest first. The state filter stays on this side: a filtered, ordered
 *  query needs a composite index, and one page of a channel's live offers is
 *  smaller than the index would be worth. */
const OPEN_OFFERS = {
  from: [{ collectionId: 'direct' }],
  orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
  limit: OFFER_PAGE,
};

const SIGNALS_FOR_RECEIVER = {
  from: [{ collectionId: 'signals' }],
  where: { fieldFilter: { field: { fieldPath: 'for' }, op: 'EQUAL', value: { stringValue: 'receiver' } } },
};

interface FirestoreDoc { name?: string; fields?: Record<string, { stringValue?: string }> }

const stringField = (doc: unknown, key: string): string | undefined =>
  (doc as FirestoreDoc | null)?.fields?.[key]?.stringValue;

const idOf = (doc: FirestoreDoc): string => (doc.name ?? '').split('/').pop() ?? '';

/** The grant the caller meant, for a receive: it has to allow reading, because
 *  the file lands on the machine this process runs on, and the channel has to
 *  be in Directo mode. Both are refused again at the server. */
async function receiveGrantFor(ctx: SendContext, channel: string | undefined): Promise<RemoteGrant> {
  const grant = resolveChannel(ctx.identity, await grantsFor(ctx.client, ctx.profile), channel);
  if (!grant.read) throw new ZasError('read_forbidden', 403);
  if (!grant.direct_mode) throw new ZasError('not_direct_mode', 409);
  return grant;
}

/** The engine's sink, writing the way `zas_get_item` does: 0600, through a
 *  temporary name beside the destination, renamed only once the engine closes
 *  it. A transfer that breaks leaves nothing behind — least of all a file with
 *  the right name and the wrong length, which reads as complete. */
class DiskSink implements Sink {
  /** Where the bytes will be once `close` has run. */
  target: string | undefined;
  written = 0;
  /** A filesystem refusal, kept so the run can answer `write_failed` rather
   *  than reporting the engine's generic sink failure. */
  failure: NodeJS.ErrnoException | undefined;

  private created: string | undefined;
  private tmp: string | undefined;
  private fd: number | undefined;

  constructor(private readonly dest: string | undefined, private readonly fallbackName: string) {}

  open(meta: DirectMeta): void {
    try {
      const chosen = destinationOf(this.dest, meta.name, this.fallbackName);
      this.target = chosen.target;
      this.created = chosen.created;
      mkdirSync(dirname(this.target), { recursive: true, mode: 0o700 });
      this.tmp = `${this.target}.${randomBytes(6).toString('hex')}.tmp`;
      this.fd = openSync(this.tmp, 'wx', 0o600);
    } catch (error) {
      throw this.remember(error);
    }
  }

  write(bytes: Uint8Array): void {
    try {
      if (this.fd === undefined) throw new Error('sink_closed');
      // The count comes from the write, not from the buffer: a short write is
      // then a size the engine's digest check refuses, not a silent truncation.
      this.written += writeSync(this.fd, bytes);
    } catch (error) {
      throw this.remember(error);
    }
  }

  close(): void {
    try {
      if (this.fd === undefined) return;
      closeSync(this.fd);
      this.fd = undefined;
      renameSync(this.tmp!, this.target!);
      this.tmp = undefined;
    } catch (error) {
      throw this.remember(error);
    }
  }

  /** Best effort, and safe to call twice: the engine aborts on every failure
   *  path of its own, and the job aborts again on the way out. */
  abort(): void {
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* already gone */ }
      this.fd = undefined;
    }
    if (this.tmp !== undefined) {
      if (existsSync(this.tmp)) try { unlinkSync(this.tmp); } catch { /* nothing to undo */ }
      this.tmp = undefined;
    }
    // The directory this run made for a file that never landed in it. `rmdir`
    // refuses one that still holds the file, so a finished run keeps its own.
    if (this.created !== undefined) {
      try { rmdirSync(this.created); } catch { /* the file is in it */ }
      this.created = undefined;
    }
  }

  /** A `ZasError` says what happened already. An errno does not, so it is kept
   *  and turned into one sentence by the caller — recognised by the shape Node
   *  puts on it (`syscall`/`errno`) rather than by `code`, which `ZasError`
   *  also carries. */
  private remember(error: unknown): unknown {
    const failure = error as NodeJS.ErrnoException;
    if (typeof failure?.syscall === 'string' || typeof failure?.errno === 'number') this.failure = failure;
    return error;
  }
}

export async function receiveDirect(
  ctx: SendContext,
  input: ReceiveInput,
  report: (phase: ReceiveJobPhase) => void,
  deps: ReceiveDeps = {},
): Promise<ReceiveResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const grant = await receiveGrantFor(ctx, input.channel);
  const key = channelKeyOf(ctx.identity, grant);
  const channelName = channelLabel(ctx, grant);
  const cid = grant.channel_id;
  const owner = ctx.identity.owner_uid;
  const device = deps.device ?? newDeviceToken();
  const { seal, open } = sealer(key, grant.key_version);
  const stamp = { device, owner_uid: owner };
  const startedAt = now();
  const channelPath = `accounts/${owner}/channels/${cid}`;

  // ---- the wait for an offer ----
  report('waiting');
  const waitUntil = startedAt + (deps.offerWaitMs ?? OFFER_WAIT_MS);
  let id: string | undefined;
  let meta: DirectMeta | undefined;
  while (id === undefined) {
    // A poll that fails is a poll: the wait's own clock decides when to stop,
    // and a network that came back should not have lost the offer.
    const rows = await ctx.client.firestoreRunQuery(channelPath, OPEN_OFFERS).catch(() => [] as unknown[]);
    for (const row of rows as FirestoreDoc[]) {
      if (stringField(row, 'state') !== 'open') continue;
      // An offer this agent made itself. Its sending job is already waiting for
      // somebody to take it, and taking it here would be one process shaking
      // hands with itself.
      if (stringField(row, 'sender') === ctx.identity.agent_uid) continue;
      const enc = stringField(row, 'meta_enc');
      if (enc === undefined) continue;
      let candidate: DirectMeta;
      try {
        candidate = open(enc) as DirectMeta;
      } catch {
        // Sealed under a generation this agent does not hold. Another device
        // can still take it; this one cannot even read the name.
        continue;
      }
      if (typeof candidate?.name !== 'string' || typeof candidate?.size !== 'number') continue;
      // Refused before the claim, not after: a claim this end cannot honour
      // takes the offer away from the phone that could.
      if (candidate.size > DIRECT_FILE_MAX_BYTES) throw new ZasError('file_too_big', 413);
      const offerId = idOf(row);
      if (offerId === '') continue;
      try {
        await ctx.client.api('POST', `/direct/${cid}/${offerId}/claim`, { size_bytes: candidate.size, ...stamp });
      } catch (error) {
        const word = error instanceof ZasError ? (error.serverCode ?? error.code) : '';
        // Another device pressed Receive first. That is how an exchange is
        // meant to work, so it is an answer and not a failure to retry.
        if (word === 'claimed') throw new ZasError('offer_taken', 409);
        // This row is gone or was never takeable. The next row, or the next
        // poll, may still hold an offer.
        if (word === 'expired' || word === 'own_offer' || word === 'not_found') continue;
        throw error;
      }
      id = offerId;
      meta = candidate;
      break;
    }
    if (id !== undefined) break;
    if (now() >= waitUntil) throw new ZasError('no_offer', 0);
    await sleep(deps.offerPollMs ?? OFFER_POLL_MS);
  }
  const offered = meta!;
  const offerId = id;

  // ---- the engine ----
  const route = `/direct/${cid}/${offerId}`;
  const offerPath = `${channelPath}/direct/${offerId}`;
  // Best effort: a state the server refused is one it already knows, and the
  // lease ends the exchange either way.
  const setState = (state: 'done' | 'failed'): Promise<void> =>
    ctx.client.api('POST', `${route}/state`, { state, ...stamp }).then(() => undefined, () => undefined);

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
  const sink = new DiskSink(input.dest, offerId);
  let resolveOutcome!: (phase: 'done' | 'failed') => void;
  const outcome = new Promise<'done' | 'failed'>((resolve) => { resolveOutcome = resolve; });
  let diag: DirectDiag | undefined;
  let via: DirectPath | undefined;
  const handle = (deps.engine ?? startReceiver)({
    ice: [...DIRECT_ICE, ...turn],
    refreshIce: async () => [...DIRECT_ICE, ...(await fetchIce())],
    // The name and size this end read off the offer. The engine refuses a
    // sender that announces anything else.
    expectedMeta: offered,
    send: (msg: SignalMsg) =>
      ctx.client.api('POST', `${route}/signal`, { payload_enc: seal(msg), for: 'sender', ...stamp }).then(() => undefined),
    onPhase: (phase) => {
      if (phase === 'flight') report('flight');
      if (phase === 'done' || phase === 'failed') resolveOutcome(phase);
    },
    onPath: (p) => { via = p; },
    onDiag: (d) => { diag = d; deps.onDiag?.(d); },
    sink: async (m) => { sink.open(m); return sink; },
  });

  // ---- the sender's signals, polled until the engine ends ----
  let over = false;
  const pump = (async () => {
    const seen = new Set<string>();
    while (!over) {
      let rows: unknown[] = [];
      try {
        rows = await ctx.client.firestoreRunQuery(offerPath, SIGNALS_FOR_RECEIVER);
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
  await pump;

  report('finishing');
  if (phase === 'done') {
    // The engine closed the sink, so the bytes are already under their final
    // name and the digest was checked before the rename.
    await setState('done');
    return {
      offer_id: offerId,
      channel_id: cid,
      channel_name: channelName,
      name: offered.name,
      bytes: sink.written,
      path: sink.target!,
      ...(via ? { via } : {}),
      duration_ms: now() - startedAt,
    };
  }

  sink.abort();
  // Read before reporting: a sender that withdrew leaves the offer
  // `cancelled`, and this end's own `failed` would overwrite the evidence.
  const doc = await ctx.client.firestoreGet(offerPath).catch(() => null);
  const withdrawn = doc === null || stringField(doc, 'state') === 'cancelled';
  await setState('failed');
  // The disk is a different failure from the wire, and the cure is the
  // caller's: a destination it cannot write to.
  if (sink.failure) throw new ZasError('write_failed', 0, sink.failure.message);
  if (withdrawn) throw new ZasError('direct_cancelled', 0);
  const reason = diag?.reason || 'unknown';
  deps.onFailed?.({
    channel_id: cid,
    channel_name: channelName,
    offer_id: offerId,
    owner_uid: owner,
    device,
    ...(input.dest !== undefined ? { dest: input.dest } : {}),
    meta: offered,
    key,
    key_version: grant.key_version,
    reason,
  });
  throw new ZasError('direct_failed', 0, reason);
}

/** The reliable-delivery path for a receive that failed in flight: the sender
 *  chose to store an encrypted copy, and this downloads and decrypts it onto
 *  the same destination the live run would have used. */
export async function receiveDirectFallback(
  ctx: SendContext,
  record: FailedReceive,
  report: (phase: ReceiveJobPhase) => void,
  deps: ReceiveDeps = {},
): Promise<ReceiveResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const { open } = sealer(record.key, record.key_version);
  const stamp = { device: record.device, owner_uid: record.owner_uid };
  const base = `/direct/${record.channel_id}/${record.offer_id}/fallback`;
  const offerPath = `accounts/${record.owner_uid}/channels/${record.channel_id}/direct/${record.offer_id}`;

  const doc = await ctx.client.firestoreGet(offerPath);
  const enc = stringField(doc, 'fallback_meta_enc');
  let meta: DirectFallbackMeta | undefined;
  if (enc !== undefined) {
    try {
      meta = fallbackMetaOf(open(enc));
    } catch {
      meta = undefined;
    }
  }
  // No layout record means the sender has not chosen reliable delivery, or the
  // copy already expired. Either way there is nothing here to download.
  if (!meta) throw new ZasError('fallback_unavailable', 409);
  // The encrypted copy has to be the file that was offered. Anything else is a
  // different file arriving under the name the person read on their screen.
  if (meta.name !== record.meta.name || meta.size !== record.meta.size || meta.mime !== record.meta.mime) {
    throw new ZasError('file_changed', 0);
  }

  const sink = new DiskSink(record.dest, record.offer_id);
  report('downloading');
  try {
    sink.open(meta);
    await downloadFallback({
      offerId: record.offer_id,
      meta,
      sink,
      getUrl: async () => (await ctx.client.api<{ url: string }>('POST', `${base}/download`, stamp)).url,
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    });
  } catch (error) {
    sink.abort();
    if (sink.failure) throw new ZasError('write_failed', 0, sink.failure.message);
    if (error instanceof ZasError) throw error;
    throw new ZasError('network', 0, error instanceof Error ? error.message : String(error));
  }
  report('finishing');
  // The receipt is what frees the stored copy: the server deletes the object
  // and writes the agent's `direct_received` entry.
  await ctx.client.api('POST', `${base}/received`, stamp);
  return {
    offer_id: record.offer_id,
    channel_id: record.channel_id,
    channel_name: record.channel_name,
    name: meta.name,
    bytes: sink.written,
    path: sink.target!,
    duration_ms: now() - startedAt,
  };
}
