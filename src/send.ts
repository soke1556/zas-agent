import { TransferTelemetry, itemKind } from './transfer-telemetry.js';
// The send pipeline, port of the browser worker (web/src/worker/send.worker.ts)
// and of scripts/dedup-bench.ts: chunk -> BLAKE3 -> OPRF -> MLE encrypt ->
// probe -> upload or prove -> link. The protocol is the client protocol; an
// agent gets no shortcut and no second format.
//
// Two things are the agent's own. Every send carries an idempotency key derived
// from the content, the channel and the title, because a coding agent retries
// where a person would not, and a lost response must not become a second item.
// And a local receipt answers an immediate repeat without a request at all.
import { extname } from 'node:path';
import { agentSendIdempotencyKey } from './shared/agent.js';
import { chunkStream } from './shared/chunker.js';
import {
  b64ToBytes, blake3Bytes, blake3Hex, bytesToB64, bytesToHex, concatBytes, hmacSha256,
} from './shared/hash.js';
import { newManifest, sealManifest, type Manifest, type ManifestChunk } from './shared/manifest.js';
import { encryptChunk, type EncryptedChunk } from './shared/mle.js';
import { oprfFinalize } from './shared/oprf.js';
import { blindDedupe } from './shared/dedupe-oprf.js';
import type { ZasClient } from './client.js';
import { ZasError } from './errors.js';
import { channelKeyOf, channelNameOf, grantsFor, resolveChannel } from './grants.js';
import {
  loadFingerprints, saveFingerprints, type Identity, type RemoteGrant, type SendReceipt,
} from './identity.js';
import { checkFilePath, UploadSource } from './upload-source.js';
export { checkFilePath, MAX_FILE_BYTES } from './upload-source.js';

export type SendPhase = 'hashing' | 'encrypting' | 'uploading' | 'finishing';

export interface SendContext {
  /** Internal, per-attempt instrumentation; never persisted. */
  transferTelemetry?: TransferTelemetry;
  identity: Identity;
  client: ZasClient;
  profile: string;
  /** How many elements go into one OPRF or probe call. Tests drive the slicing
   *  with a small number; nothing else sets it. */
  batch?: number;
}

export interface SendFileInput { path: string; channel?: string; title?: string; expires_in_days?: number }
export interface SendNoteInput { text: string; channel?: string; title?: string; lang?: string; secret?: boolean; expires_in_days?: number }

export interface SendResult {
  link_id: string;
  channel_id: string;
  channel_name: string;
  bytes: number;
  chunks: number;
  /** How many chunks the server already held, so nothing went over the wire. */
  deduplicated: number;
  /** Answered from the local receipt: this exact send already happened. */
  replayed: boolean;
}

/** Plaintext held by a batch. Chunker lookahead and encryption buffers add a
 * fixed overhead; file size only grows the small manifest entries. */
export const UPLOAD_BATCH_BYTES = 16 * 1024 * 1024;

/** How long an identical send is answered from the receipt instead of the
 *  network. Past it the request goes out and the server's idempotency key is
 *  what keeps the item single. */
const REPLAY_WINDOW_MS = 10 * 60 * 1000;

/** Four at a time, like the browser's fetch pool. All at once would hold every
 *  ciphertext of a multi-gigabyte file in flight at the same moment. */
const UPLOAD_CONCURRENCY = 4;

/** How many chunks go into one `POST /oprf/evaluate` and one `POST
 *  /blobs/probe`. The server refuses more than 256 blinded elements and more
 *  than 512 ids; one number under both caps means a file at the 5 GiB hard
 *  stop is sliced instead of refused with a bare `bad_request`. */
export const OPRF_PROBE_BATCH = 200;

/** How many refused proofs one send may spend. The server allows ten an hour
 *  per agent and answers 429 after that, which is not `proof_failed` and would
 *  kill the send in progress. Eight leaves the next send in the hour something
 *  to work with, and a send that has been refused eight times has learnt what
 *  a ninth refusal would tell it. */
export const MAX_REFUSALS_PER_SEND = 8;

const NOTE_NAME_MAX = 40;

/** `items` in slices of at most `size`, in order. */
function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** How long a slice may be. `ctx.batch` is public and tests set it, so a
 *  fraction, a zero or a negative has to become a whole number of at least
 *  one: `batches` would otherwise never advance. */
function sliceSize(ctx: SendContext): number {
  const size = ctx.batch ?? OPRF_PROBE_BATCH;
  return Number.isFinite(size) ? Math.max(1, Math.min(OPRF_PROBE_BATCH, Math.floor(size))) : OPRF_PROBE_BATCH;
}

const MIME = new Map<string, string>(Object.entries({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ts: 'text/typescript', js: 'text/javascript', py: 'text/x-python', go: 'text/x-go',
  rs: 'text/x-rust', java: 'text/x-java', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++',
  sh: 'application/x-sh', yml: 'application/yaml', yaml: 'application/yaml',
  toml: 'application/toml', xml: 'application/xml',
}));

/** The extension's claim about the bytes, and nothing more. A receiver decides
 *  what it will render from its own allowlist (web/src/lib/openable.ts). */
export function mimeFor(path: string): string {
  return MIME.get(extname(path).slice(1).toLowerCase()) ?? 'application/octet-stream';
}

interface ProbeChallenge { challenge_id: string; nonce: string; offsets: number[]; sample_len: number }
interface ProbeAnswer { results?: Record<string, string>; challenges?: Record<string, ProbeChallenge> }
export interface Placed { entry: ManifestChunk; proven?: boolean }
/** Where one blob id ended up: the cap that names it, and whether the server
 *  already held the bytes. One per distinct id, not one per manifest entry. */
interface Placement { cap: string; proven: boolean }

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, index: number, signal: AbortSignal) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  const controller = new AbortController();
  const runner = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { out[index] = await work(items[index], index, controller.signal); }
      catch (error) {
        if (!failed) failure = error;
        failed = true;
        controller.abort();
      }
    }
  };
  // Drain requests already in flight before releasing a failed batch. A
  // retry must not overlap orphaned workers still scheduling more uploads.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  if (failed) throw failure;
  return out;
}

/** The grant the caller meant, refused here rather than at the server when the
 *  answer is already knowable. `view` is a permission on the channel, not on
 *  the grant, and it outranks a `send` the owner set before switching modes. */
async function grantFor(ctx: SendContext, channel: string | undefined): Promise<RemoteGrant> {
  const grant = resolveChannel(ctx.identity, await grantsFor(ctx.client, ctx.profile), channel);
  if (!grant.send || grant.mode === 'view') throw new ZasError('send_forbidden', 403);
  if (grant.direct_mode) throw new ZasError('direct_mode', 409);
  return grant;
}

/** Scoped to the agent uid: a profile paired again is a different principal,
 *  and it must not be told its first send already happened. Hashed rather than
 *  stored in the clear: `fingerprints.json` would otherwise hold every title
 *  and note-first-line an agent ever sent, in plain text, on disk. */
async function receiptKey(ctx: SendContext, channelId: string, contentHash: string, title: string): Promise<string> {
  const raw = `${ctx.identity.agent_uid}\0${channelId}\0${contentHash}\0${title}`;
  return blake3Hex(new TextEncoder().encode(raw));
}

/** The identity of one send: what was sent, and how long it was asked to live
 *  for. The bytes alone are not it. Both replay guards key on this string —
 *  the local receipt and the server's idempotency key — and without the
 *  lifetime in it, "send that again, but for one day" matches the receipt of
 *  the five-day send and answers from disk with the old item's id, having
 *  created nothing.
 *
 *  A send that asks for nothing hashes to exactly the content hash it always
 *  did, so every receipt written before this existed still matches. */
async function sendIdentity(contentHash: string, days: number | undefined): Promise<string> {
  if (days === undefined) return contentHash;
  return blake3Hex(new TextEncoder().encode(`${contentHash}\0expires_in_days:${days}`));
}

function receiptFor(ctx: SendContext, key: string): SendReceipt | undefined {
  const entries = loadFingerprints(ctx.profile).entries;
  if (!Object.prototype.hasOwnProperty.call(entries, key)) return undefined;
  const entry = entries[key];
  if (!entry || typeof entry.at !== 'number' || Date.now() - entry.at >= REPLAY_WINDOW_MS) return undefined;
  return entry;
}

function remember(ctx: SendContext, key: string, receipt: SendReceipt): void {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  const entries: Record<string, SendReceipt> = {};
  for (const [k, v] of Object.entries(loadFingerprints(ctx.profile).entries)) {
    if (v && typeof v.at === 'number' && v.at >= cutoff) entries[k] = v;
  }
  entries[key] = receipt;
  saveFingerprints(ctx.profile, { entries });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** A flat delay, not backoff: this is one retry, not a policy. */
const CHUNK_PUT_RETRY_DELAY_MS = 1000;

/** One retry, after a flat delay, for a thrown fetch (a network blip) or a 5xx
 *  from the object store — both are the store's problem, not the request's,
 *  and worth trying again exactly once. A 4xx says the request itself is
 *  wrong (a stale or malformed presigned URL); trying again would not change
 *  that, so it returns immediately and lets the caller turn it into
 *  `upload_failed`. */
async function putWithRetry(url: string, body: Uint8Array, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let res: Response;
    try {
      // No content type: the presigned URL was signed without one, and adding
      // a header the signature does not cover is a 403 from the object store.
      // The cast is the DOM lib's: a Uint8Array is a perfectly good body, and
      // undici takes one, but `BodyInit` under these lib settings does not say so.
      res = await fetch(url, { method: 'PUT', body: body as unknown as BodyInit,
        signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) });
    } catch {
      signal.throwIfAborted();
      // Status 0: there was no answer to read a status from. The original
      // fetch error is not rethrown, because a caller that is not the
      // JobRunner would get a bare TypeError with no code at all.
      if (attempt > 0) throw new ZasError('upload_failed', 0);
      await sleep(CHUNK_PUT_RETRY_DELAY_MS);
      continue;
    }
    if (res.ok || res.status < 500 || attempt > 0) return res;
    await res.body?.cancel().catch(() => undefined);
    await sleep(CHUNK_PUT_RETRY_DELAY_MS);
  }
}

/** The server marks a commit that raced another account's promotion of the
 *  same blob as retryable (409 `commit_pending`). Four attempts with a
 *  doubling delay, exactly as the browser does (send.worker.ts:326-335); every
 *  other answer is final and propagates as it arrived. */
const COMMIT_ATTEMPTS = 4;
const COMMIT_RETRY_BASE_MS = 250;

async function commitChunk(ctx: SendContext, blobId: string, uploadId: string, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    try {
      const { cap } = await ctx.client.api<{ cap: string }>(
        'POST', `/blobs/${blobId}/commit`, { upload_id: uploadId }, {}, signal,
      );
      return cap;
    } catch (err) {
      if (!(err instanceof ZasError) || err.serverCode !== 'commit_pending') throw err;
      if (attempt === COMMIT_ATTEMPTS - 1) break;
      await sleep(COMMIT_RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw new ZasError('upload_failed', 409);
}

async function uploadChunk(ctx: SendContext, enc: EncryptedChunk, signal: AbortSignal): Promise<string> {
  const reserved = await ctx.client.api<{ upload_id?: string; url?: string }>(
    'POST', `/blobs/${enc.blobId}/upload-url`, { size: enc.ciphertext.length }, {}, signal,
  );
  if (typeof reserved.url !== 'string' || typeof reserved.upload_id !== 'string') {
    throw new ZasError('upload_failed', 0);
  }
  signal.throwIfAborted();
  const put = await putWithRetry(reserved.url, enc.ciphertext, signal);
  if (!put.ok) {
    await put.body?.cancel().catch(() => undefined);
    throw new ZasError('upload_failed', put.status);
  }
  return commitChunk(ctx, enc.blobId, reserved.upload_id, signal);
}

/** One proof, answered while its challenge is seconds old. The cap on
 *  success, `null` when the server refused the proof — a challenge can expire,
 *  or its canonical object can disappear, between the probe and the proof, and
 *  the ciphertext is still in hand, so that answer means "upload it". Any
 *  other error is a real failure and stops the send, exactly as it does in the
 *  browser (send.worker.ts:285-287). */
async function proveChunk(
  ctx: SendContext,
  enc: EncryptedChunk,
  challenge: ProbeChallenge,
  signal?: AbortSignal,
): Promise<string | null> {
  const samples = challenge.offsets.map((o) => enc.ciphertext.slice(o, o + challenge.sample_len));
  try {
    const { cap } = await ctx.client.api<{ cap: string }>('POST', `/blobs/${enc.blobId}/prove`, {
      challenge_id: challenge.challenge_id,
      mac: bytesToHex(hmacSha256(b64ToBytes(challenge.nonce), concatBytes(...samples))),
    }, {}, signal);
    return cap;
  } catch (err) {
    if (!(err instanceof ZasError) || err.serverCode !== 'proof_failed') throw err;
    return null;
  }
}

/** One slice: probe it, answer every proof it asked for, and only then upload
 *  what is left. Prove before upload, because a challenge lives two minutes
 *  and an upload of the same slice can take longer than that; a proof that
 *  waited behind one arrives expired, and after ten refusals in an hour the
 *  server answers 429 `rate_limited`, which is not `proof_failed` and kills
 *  the send. The slice holds distinct blob ids, so the two lists below
 *  partition it. */
async function placeSlice(
  ctx: SendContext,
  slice: EncryptedChunk[],
  into: Map<string, Placement>,
  budget: { refusals: number },
): Promise<void> {
  const probe = await ctx.client.api<ProbeAnswer>('POST', '/blobs/probe', {
    ids: slice.map((e) => e.blobId),
  });
  const results = probe.results ?? {};
  const challenges = probe.challenges ?? {};
  // 451: the one refusal that is about the content itself, and the only status
  // that says so without inventing a code outside the closed set. Checked for
  // the whole slice before anything in this slice is placed, so a blocked
  // chunk cannot be reached only after its neighbours went over the wire.
  for (const enc of slice) {
    if (results[enc.blobId] === 'blocked') throw new ZasError('upload_failed', 451);
  }

  // Everything that is not "prove" uploads. The server answers the same word
  // for "never seen" and "here but below its threshold" on purpose, and this
  // side stays just as incurious (spec 5.4).
  const provable: EncryptedChunk[] = [];
  const upload: EncryptedChunk[] = [];
  for (const enc of slice) {
    if (results[enc.blobId] === 'prove' && challenges[enc.blobId]) provable.push(enc);
    else upload.push(enc);
  }

  // The first refusal ends the proving of this slice: the challenges of a
  // slice are the same age and came from the same probe, so one refusal is
  // the whole news, and each further one spends a unit of the ten an agent
  // gets per hour. That is also why one proof is risked alone before the rest
  // go out together — at four in flight a dead slice would spend four.
  //
  // The count is also carried across the slices of one send: a large file has
  // many slices, and a send that keeps being refused would otherwise empty the
  // hour's budget by itself and leave the next send answering 429 — which is
  // not `proof_failed` and kills it. After MAX_REFUSALS_PER_SEND this send
  // stops proving and simply uploads the rest.
  let refused = budget.refusals >= MAX_REFUSALS_PER_SEND;
  const prove = async (enc: EncryptedChunk, _index?: number, signal?: AbortSignal): Promise<void> => {
    if (refused) {
      upload.push(enc);
      return;
    }
    const cap = await proveChunk(ctx, enc, challenges[enc.blobId], signal);
    if (cap === null) {
      refused = true;
      budget.refusals += 1;
      upload.push(enc);
      return;
    }
    into.set(enc.blobId, { cap, proven: true });
  };
  if (provable.length > 0) await prove(provable[0]);
  await mapLimit(provable.slice(1), UPLOAD_CONCURRENCY, prove);

  await mapLimit(upload, UPLOAD_CONCURRENCY, async (enc, _index, signal) => {
    into.set(enc.blobId, { cap: await uploadChunk(ctx, enc, signal), proven: false });
  });
}

/** probe -> prove | upload, one slice at a time, in manifest order. The browser
 *  probes a single blob immediately before proving it (send.worker.ts:254-297)
 *  and so never has to think about this; the agent batches its calls, so it
 *  places a slice fully before it asks for the next slice's challenges. */
async function placeChunks(
  ctx: SendContext, encs: EncryptedChunk[],
  placements: Map<string, Placement>, budget: { refusals: number },
): Promise<Placed[]> {
  if (encs.length === 0) return [];
  // Two identical plaintext chunks in one file have one blob id, and the
  // server issues one challenge per id and deletes it on the first attempt to
  // answer it (api.ts:4251). Placing the id twice would therefore see the
  // second proof refused, upload a blob the server already holds, and spend
  // one of the ten refusals an hour for nothing. Each distinct id is placed
  // once and its cap copied into every manifest entry that names it.
  const distinct: EncryptedChunk[] = [];
  const seen = new Set<string>();
  for (const enc of encs) {
    if (seen.has(enc.blobId) || placements.has(enc.blobId)) continue;
    seen.add(enc.blobId);
    distinct.push(enc);
  }

  for (const slice of batches(distinct, sliceSize(ctx))) await placeSlice(ctx, slice, placements, budget);

  return encs.map((enc): Placed => {
    const placement = placements.get(enc.blobId);
    // Every distinct id went through a slice, so this cannot happen; saying so
    // out loud costs less than a non-null assertion that hides it.
    if (!placement) throw new ZasError('upload_failed', 0);
    return {
      entry: {
        blob_id: enc.blobId,
        key: bytesToB64(enc.key),
        nonce: bytesToB64(enc.nonce),
        size: enc.ciphertext.length,
        cap: placement.cap,
      },
      proven: placement.proven,
    };
  });
}

async function postLink(
  ctx: SendContext,
  grant: RemoteGrant,
  manifest: Manifest,
  placed: Placed[],
  idempotencyKey: string,
  expiresInDays?: number,
): Promise<string> {
  const channelKey = channelKeyOf(ctx.identity, grant);
  const sealed = sealManifest(channelKey, manifest, grant.key_version);
  const created = await ctx.client.api<{ link_id: string; caps?: Record<string, string> }>('POST', '/links', {
    channel_id: grant.channel_id,
    manifest_enc: bytesToB64(sealed),
    caps: placed.map((p) => p.entry.cap).filter((cap): cap is string => typeof cap === 'string'),
    // Every chunk now arrives with a cap, proven or uploaded, so there is
    // nothing left for the server to verify here. The field stays because the
    // server reads it, and an absent array is not the same as an empty one.
    proofs: [],
    idempotency_key: idempotencyKey,
    // Absent unless the caller asked. The server clamps whatever arrives to
    // the account's own plan, so this can only ever shorten the item's life.
    ...(expiresInDays === undefined ? {} : { expires_in_days: expiresInDays }),
  });

  // The link answers with caps bound to it, covering every chunk — including
  // a proven one, which arrived with no cap at all. They replace the unbound
  // upload caps in the manifest: retrieval works with either, but pinning and
  // deleting require the bound ones. `manifest.chunks` are the same objects as
  // `placed.map(p => p.entry)` (see sendFile/sendNote), so this mutates them
  // in place and reseals the one manifest object both callers already hold.
  const bound = created.caps ?? {};
  let patched = false;
  for (const p of placed) {
    const cap = bound[p.entry.blob_id];
    if (cap) {
      p.entry.cap = cap;
      patched = true;
    }
  }
  if (patched) {
    await ctx.client.api('PATCH', `/links/${grant.channel_id}/${created.link_id}`, {
      manifest_enc: bytesToB64(sealManifest(channelKey, manifest, grant.key_version)),
    });
  }
  return created.link_id;
}

/** The placement half of a send: chunk, hash, OPRF, encrypt, then probe and
 *  upload or prove. One placed entry per chunk, with the cap the server
 *  issued; the link — or the replace — is the caller's to make. */
export async function placeFile(
  ctx: SendContext,
  source: Uint8Array | AsyncIterable<Uint8Array>,
  onPhase?: (phase: SendPhase) => void,
): Promise<Placed[]> {
  onPhase?.('hashing');
  const policy = await ctx.client.dedupePolicy();
  const placements = new Map<string, Placement>();
  const budget = { refusals: 0 };
  const placed: Placed[] = [];
  let plains: Uint8Array[] = [];
  let byteCount = 0;
  const flush = async () => {
    if (plains.length === 0) return;
    const hashes = await Promise.all(plains.map((p) => blake3Bytes(p)));
    const blinds = hashes.map((h) => blindDedupe(h, policy));
    const evaluated = await ctx.client.oprfEvaluate(blinds.map((b) => bytesToB64(b.blindedElement)), policy);
    if (evaluated.length !== plains.length) throw new ZasError('oprf_failed', 0);
    onPhase?.('encrypting');
    let outputs: Uint8Array[];
    try { outputs = hashes.map((hash, i) => oprfFinalize(hash, blinds[i].blind, b64ToBytes(evaluated[i]))); }
    catch { throw new ZasError('oprf_failed', 0); }
    const encs = await Promise.all(plains.map((plain, i) => encryptChunk(outputs[i], plain)));
    plains = [];
    byteCount = 0;
    onPhase?.('uploading');
    placed.push(...await placeChunks(ctx, encs, placements, budget));
  };
  // Even callers with an in-memory buffer feed small pieces to the chunker;
  // its remainder copies must not grow with the size of the whole file.
  const pieces = async function* () {
    const input = source instanceof Uint8Array ? [source] : source;
    for await (const bytes of input) {
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) yield bytes.subarray(offset, offset + 1024 * 1024);
    }
  };
  for await (const piece of chunkStream(pieces())) {
    if (byteCount + piece.length > UPLOAD_BATCH_BYTES || plains.length >= sliceSize(ctx)) await flush();
    plains.push(piece);
    byteCount += piece.length;
    if (byteCount === UPLOAD_BATCH_BYTES || plains.length === sliceSize(ctx)) await flush();
  }
  await flush();
  return placed;
}

/** Drops every receipt naming a link, after that link changed: "send that
 *  again" has to make a new item, not answer with the id of one that no
 *  longer holds what the receipt says it does. */
export function forgetLink(profile: string, linkId: string): void {
  const entries: Record<string, SendReceipt> = {};
  let dropped = false;
  for (const [k, v] of Object.entries(loadFingerprints(profile).entries)) {
    if (v && v.link_id === linkId) dropped = true;
    else entries[k] = v;
  }
  if (dropped) saveFingerprints(profile, { entries });
}

async function sendFileMeasured(
  ctx: SendContext,
  input: SendFileInput,
  onPhase?: (phase: SendPhase) => void,
): Promise<SendResult> {
  // The path before the grant: a refusal here costs no request.
  await checkFilePath(input.path);
  const grant = await grantFor(ctx, input.channel);
  const source = await UploadSource.open(input.path);
  try {
    const { size, name } = source;
    ctx.transferTelemetry?.describe(size);
    const title = input.title ?? name;
    onPhase?.('hashing');
    const contentHash = await sendIdentity(await source.contentHash(), input.expires_in_days);
    const key = await receiptKey(ctx, grant.channel_id, contentHash, title);
    const stored = receiptFor(ctx, key);
    if (stored) {
      return {
        link_id: stored.link_id,
        channel_id: grant.channel_id,
        channel_name: channelNameOf(ctx.identity, grant),
        bytes: stored.bytes,
        chunks: stored.chunks,
        deduplicated: stored.deduplicated,
        replayed: true,
      };
    }

    const placed = await placeFile(ctx, source.bytes(), (phase) => { if (phase !== 'hashing') onPhase?.(phase); });

    onPhase?.('finishing');
    const mime = mimeFor(input.path);
    const thumb = await source.thumbnail(mime);
    await source.unchanged();
    const manifest = newManifest({
      kind: 'file',
      name,
      // Only when the caller chose one: absence means "show the file name", and
      // writing the file name into `title` would make a rename look deliberate.
      ...(input.title !== undefined ? { title: input.title } : {}),
      mime,
      size,
      created_at: new Date().toISOString(),
      ...(thumb ? { thumb_data: thumb } : {}),
      chunks: placed.map((p) => p.entry),
    });
    ctx.transferTelemetry?.mark("finishing");
    const linkId = await postLink(
      ctx, grant, manifest, placed, agentSendIdempotencyKey(grant.channel_id, contentHash, title),
      input.expires_in_days,
    );

    const deduplicated = placed.filter((p) => p.proven).length;
    remember(ctx, key, {
      link_id: linkId, bytes: size, chunks: placed.length, deduplicated, at: Date.now(),
    });
    return {
      link_id: linkId,
      channel_id: grant.channel_id,
      channel_name: channelNameOf(ctx.identity, grant),
      bytes: size,
      chunks: placed.length,
      deduplicated,
      replayed: false,
    };
  } finally { await source.close(); }
}

/** The first line, clipped. A note has no file name, and the whole text as a
 *  label would fill the row it is supposed to introduce. */
export function noteName(text: string): string {
  return text.split('\n', 1)[0].trim().slice(0, NOTE_NAME_MAX) || 'nota';
}

async function sendNoteMeasured(ctx: SendContext, input: SendNoteInput): Promise<SendResult> {
  const grant = await grantFor(ctx, input.channel);
  const name = input.title ?? noteName(input.text);
  const encoded = new TextEncoder().encode(input.text);
  ctx.transferTelemetry?.describe(encoded.length);
  ctx.transferTelemetry?.mark("encrypting");
  // The flags are part of the content, not decoration on it. Hashing the text
  // alone made "send that again, marked secret" a replay: the receipt matched,
  // the agent answered from disk, and the item in the channel kept no
  // `sensitive` flag at all. Past the receipt window the server's own
  // idempotency key did the same thing, and it does not rewrite a manifest.
  const contentHash = await sendIdentity(
    await blake3Hex(new TextEncoder().encode(
      `${input.lang ?? ''}\0${input.secret ? '1' : '0'}\0${input.text}`,
    )),
    input.expires_in_days,
  );
  const key = await receiptKey(ctx, grant.channel_id, contentHash, name);
  const stored = receiptFor(ctx, key);
  if (stored) {
    return {
      link_id: stored.link_id,
      channel_id: grant.channel_id,
      channel_name: channelNameOf(ctx.identity, grant),
      bytes: stored.bytes,
      chunks: 0,
      deduplicated: 0,
      replayed: true,
    };
  }

  const manifest = newManifest({
    kind: 'text',
    name,
    ...(input.title !== undefined ? { title: input.title } : {}),
    mime: 'text/plain',
    size: encoded.length,
    created_at: new Date().toISOString(),
    text: input.text,
    ...(input.lang ? { code: { lang: input.lang, auto: false } } : {}),
    // Only ever true or absent, exactly as the note cover is defined: absent is
    // "the sender did not classify", which no receiver may read as safe.
    ...(input.secret ? { sensitive: true } : {}),
    chunks: [],
  });
  ctx.transferTelemetry?.mark("finishing");
  const linkId = await postLink(
    ctx, grant, manifest, [], agentSendIdempotencyKey(grant.channel_id, contentHash, name),
    input.expires_in_days,
  );

  remember(ctx, key, {
    link_id: linkId, bytes: encoded.length, chunks: 0, deduplicated: 0, at: Date.now(),
  });
  return {
    link_id: linkId,
    channel_id: grant.channel_id,
    channel_name: channelNameOf(ctx.identity, grant),
    bytes: encoded.length,
    chunks: 0,
    deduplicated: 0,
    replayed: false,
  };
}

export async function sendFile(...args: Parameters<typeof sendFileMeasured>): ReturnType<typeof sendFileMeasured> {
  const telemetry = new TransferTelemetry(args[0].client, 'upload', 'file', 'storage');
  try {
    const report = args[2];
    const result = await sendFileMeasured({ ...args[0], transferTelemetry: telemetry }, args[1], (phase) => { telemetry.mark(phase); report?.(phase); });
    telemetry.describe(result.bytes);
    telemetry.finish('success', 'none', result.replayed);
    return result;
  } catch (error) { telemetry.failed(error); throw error; }
}

export async function sendNote(...args: Parameters<typeof sendNoteMeasured>): ReturnType<typeof sendNoteMeasured> {
  const telemetry = new TransferTelemetry(args[0].client, 'upload', itemKind({text: args[1].text, lang: args[1].lang}), 'manifest');
  try {
    const result = await sendNoteMeasured({ ...args[0], transferTelemetry: telemetry }, ...args.slice(1) as Tail<typeof args>);
    telemetry.describe(result.bytes);
    telemetry.finish('success', 'none', result.replayed);
    return result;
  } catch (error) { telemetry.failed(error); throw error; }
}

type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
