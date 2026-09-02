// The send pipeline, port of the browser worker (web/src/worker/send.worker.ts)
// and of scripts/dedup-bench.ts: chunk -> BLAKE3 -> OPRF -> MLE encrypt ->
// probe -> upload or prove -> link. The protocol is the client protocol; an
// agent gets no shortcut and no second format.
//
// Two things are the agent's own. Every send carries an idempotency key derived
// from the content, the channel and the title, because a coding agent retries
// where a person would not, and a lost response must not become a second item.
// And a local receipt answers an immediate repeat without a request at all.
import { promises as fsp } from 'node:fs';
import { basename, extname } from 'node:path';
import { agentSendIdempotencyKey } from './shared/agent.js';
import { chunkStream } from './shared/chunker.js';
import {
  b64ToBytes, blake3Bytes, blake3Hex, bytesToB64, bytesToHex, concatBytes, hmacSha256,
} from './shared/hash.js';
import { newManifest, sealManifest, type Manifest, type ManifestChunk } from './shared/manifest.js';
import { encryptChunk, type EncryptedChunk } from './shared/mle.js';
import { oprfBlind, oprfFinalize } from './shared/oprf.js';
import type { ZasClient } from './client.js';
import { ZasError } from './errors.js';
import { channelKeyOf, channelNameOf, grantsFor, resolveChannel } from './grants.js';
import {
  loadFingerprints, saveFingerprints, type Identity, type RemoteGrant, type SendReceipt,
} from './identity.js';
import { thumbnailFor } from './thumbnail.js';

export type SendPhase = 'hashing' | 'encrypting' | 'uploading' | 'finishing';

export interface SendContext {
  identity: Identity;
  client: ZasClient;
  profile: string;
  /** How many elements go into one OPRF or probe call. Tests drive the slicing
   *  with a small number; nothing else sets it. */
  batch?: number;
}

export interface SendFileInput { path: string; channel?: string; title?: string }
export interface SendNoteInput { text: string; channel?: string; title?: string; lang?: string; secret?: boolean }

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

/** A hard stop this side of the wire, so a mistyped path cannot spend an hour
 *  hashing a disk image. The plan limit is the server's to enforce, and it is
 *  lower than this for everyone. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

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
  return Math.max(1, Math.floor(ctx.batch ?? OPRF_PROBE_BATCH));
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
interface Placed { entry: ManifestChunk; proven?: boolean }
/** Where one blob id ended up: the cap that names it, and whether the server
 *  already held the bytes. One per distinct id, not one per manifest entry. */
interface Placement { cap: string; proven: boolean }

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
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
async function putWithRetry(url: string, body: Uint8Array): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      // No content type: the presigned URL was signed without one, and adding
      // a header the signature does not cover is a 403 from the object store.
      // The cast is the DOM lib's: a Uint8Array is a perfectly good body, and
      // undici takes one, but `BodyInit` under these lib settings does not say so.
      res = await fetch(url, { method: 'PUT', body: body as unknown as BodyInit });
    } catch {
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

async function commitChunk(ctx: SendContext, blobId: string, uploadId: string): Promise<string> {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    try {
      const { cap } = await ctx.client.api<{ cap: string }>(
        'POST', `/blobs/${blobId}/commit`, { upload_id: uploadId },
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

async function uploadChunk(ctx: SendContext, enc: EncryptedChunk): Promise<string> {
  const reserved = await ctx.client.api<{ upload_id?: string; url?: string }>(
    'POST', `/blobs/${enc.blobId}/upload-url`, { size: enc.ciphertext.length },
  );
  if (typeof reserved.url !== 'string' || typeof reserved.upload_id !== 'string') {
    throw new ZasError('upload_failed', 0);
  }
  const put = await putWithRetry(reserved.url, enc.ciphertext);
  if (!put.ok) {
    await put.body?.cancel().catch(() => undefined);
    throw new ZasError('upload_failed', put.status);
  }
  return commitChunk(ctx, enc.blobId, reserved.upload_id);
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
): Promise<string | null> {
  const samples = challenge.offsets.map((o) => enc.ciphertext.slice(o, o + challenge.sample_len));
  try {
    const { cap } = await ctx.client.api<{ cap: string }>('POST', `/blobs/${enc.blobId}/prove`, {
      challenge_id: challenge.challenge_id,
      mac: bytesToHex(hmacSha256(b64ToBytes(challenge.nonce), concatBytes(...samples))),
    });
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
  const prove = async (enc: EncryptedChunk): Promise<void> => {
    if (refused) {
      upload.push(enc);
      return;
    }
    const cap = await proveChunk(ctx, enc, challenges[enc.blobId]);
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

  await mapLimit(upload, UPLOAD_CONCURRENCY, async (enc) => {
    into.set(enc.blobId, { cap: await uploadChunk(ctx, enc), proven: false });
  });
}

/** probe -> prove | upload, one slice at a time, in manifest order. The browser
 *  probes a single blob immediately before proving it (send.worker.ts:254-297)
 *  and so never has to think about this; the agent batches its calls, so it
 *  places a slice fully before it asks for the next slice's challenges. */
async function placeChunks(ctx: SendContext, encs: EncryptedChunk[]): Promise<Placed[]> {
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
    if (seen.has(enc.blobId)) continue;
    seen.add(enc.blobId);
    distinct.push(enc);
  }

  const placements = new Map<string, Placement>();
  const budget = { refusals: 0 };
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

export async function sendFile(
  ctx: SendContext,
  input: SendFileInput,
  onPhase?: (phase: SendPhase) => void,
): Promise<SendResult> {
  // stat before read: refusing a file this side of the wire is only useful if
  // it happens before the bytes are in memory.
  // Any stat failure is the same answer: the caller named a path this agent
  // cannot use. ENOENT, ENOTDIR under a regular file, EACCES on a directory it
  // may not traverse — the errno is the caller's business, and letting it out
  // would print a raw Node error where a sentence belongs.
  const stat = await fsp.stat(input.path).catch(() => {
    throw new ZasError('upload_failed', 400);
  });
  // A directory, a FIFO or a character device all report size 0, so the guard
  // below would never fire and `readFile` would run to EOF — `/dev/zero` until
  // the process dies. The path comes from a coding agent that is only
  // semi-trusted, so it is checked rather than assumed.
  if (!stat.isFile()) throw new ZasError('upload_failed', 400);
  if (stat.size > MAX_FILE_BYTES) throw new ZasError('file_too_big', 413);

  const grant = await grantFor(ctx, input.channel);
  const name = basename(input.path);
  const title = input.title ?? name;
  // A view, not a copy: `new Uint8Array(buffer)` would hold the file twice.
  const file = await fsp.readFile(input.path);
  // The stat above is the cheap early exit; the file may have grown since.
  if (file.byteLength > MAX_FILE_BYTES) throw new ZasError('file_too_big', 413);
  const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  const contentHash = await blake3Hex(bytes);
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

  onPhase?.('hashing');
  const plains: Uint8Array[] = [];
  for await (const piece of chunkStream([bytes])) plains.push(piece);
  const hashes = await Promise.all(plains.map((p) => blake3Bytes(p)));
  const blinds = hashes.map((h) => oprfBlind(h));
  const evaluated: string[] = [];
  for (const slice of batches(blinds.map((b) => bytesToB64(b.blindedElement)), sliceSize(ctx))) {
    // In order, and concatenated in order: the i-th evaluation belongs to the
    // i-th blind, and nothing downstream carries an index of its own. Each
    // slice is measured against its own request rather than the total, because
    // one short answer followed by one long one adds up correctly and pairs
    // every hash after it with the wrong evaluation.
    const answers = await ctx.client.oprfEvaluate(slice);
    if (answers.length !== slice.length) throw new ZasError('oprf_failed', 0);
    for (const one of answers) evaluated.push(one);
  }

  onPhase?.('encrypting');
  const encs = await Promise.all(plains.map(
    (plain, i) => encryptChunk(oprfFinalize(hashes[i], blinds[i].blind, b64ToBytes(evaluated[i])), plain),
  ));

  onPhase?.('uploading');
  const placed = await placeChunks(ctx, encs);

  onPhase?.('finishing');
  const mime = mimeFor(input.path);
  const thumb = await thumbnailFor(bytes, mime);
  const manifest = newManifest({
    kind: 'file',
    name,
    // Only when the caller chose one: absence means "show the file name", and
    // writing the file name into `title` would make a rename look deliberate.
    ...(input.title !== undefined ? { title: input.title } : {}),
    mime,
    size: bytes.length,
    created_at: new Date().toISOString(),
    ...(thumb ? { thumb_data: thumb } : {}),
    chunks: placed.map((p) => p.entry),
  });
  const linkId = await postLink(
    ctx, grant, manifest, placed, agentSendIdempotencyKey(grant.channel_id, contentHash, title),
  );

  const deduplicated = placed.filter((p) => p.proven).length;
  remember(ctx, key, {
    link_id: linkId, bytes: bytes.length, chunks: placed.length, deduplicated, at: Date.now(),
  });
  return {
    link_id: linkId,
    channel_id: grant.channel_id,
    channel_name: channelNameOf(ctx.identity, grant),
    bytes: bytes.length,
    chunks: placed.length,
    deduplicated,
    replayed: false,
  };
}

/** The first line, clipped. A note has no file name, and the whole text as a
 *  label would fill the row it is supposed to introduce. */
function noteName(text: string): string {
  return text.split('\n', 1)[0].trim().slice(0, NOTE_NAME_MAX) || 'nota';
}

export async function sendNote(ctx: SendContext, input: SendNoteInput): Promise<SendResult> {
  const grant = await grantFor(ctx, input.channel);
  const name = input.title ?? noteName(input.text);
  const encoded = new TextEncoder().encode(input.text);
  // The flags are part of the content, not decoration on it. Hashing the text
  // alone made "send that again, marked secret" a replay: the receipt matched,
  // the agent answered from disk, and the item in the channel kept no
  // `sensitive` flag at all. Past the receipt window the server's own
  // idempotency key did the same thing, and it does not rewrite a manifest.
  const contentHash = await blake3Hex(new TextEncoder().encode(
    `${input.lang ?? ''}\0${input.secret ? '1' : '0'}\0${input.text}`,
  ));
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
  const linkId = await postLink(
    ctx, grant, manifest, [], agentSendIdempotencyKey(grant.channel_id, contentHash, name),
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
