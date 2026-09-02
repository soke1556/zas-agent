// The read half of the protocol: what a channel holds, and the bytes behind
// one row. It is the browser's download path with nothing added — the same
// Firestore rows, the same sealed manifest, the same public redeem, the same
// chunk decryption (web/src/lib/transfer.ts). The server grew no route for
// this, and an agent gets no shortcut: a grant without `read` is refused here,
// and refused again by the security rules if it is revoked mid-listing.
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmdirSync, statSync, unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { b64ToBytes } from './shared/hash.js';
import {
  decryptChannelName, openManifest, type Manifest, type ManifestChunk,
} from './shared/manifest.js';
import { decryptChunk } from './shared/mle.js';
import { apiPublic } from './client.js';
import { ZasError } from './errors.js';
import { channelKeyOf, grantsFor, resolveChannel } from './grants.js';
import type { Identity, RemoteGrant } from './identity.js';
import type { SendContext } from './send.js';

/** One page of a channel, as much as a terminal can read at once. The ceiling
 *  is the agent's, not the server's: a listing is one query either way, and a
 *  caller that asks for a thousand rows wants a search, not a list. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Where a download lands when the caller named no destination: a directory of
 *  its own, made fresh for the call. Under the system temp directory rather
 *  than the profile — these are the user's files, not the agent's state — and
 *  never a shared, predictable name, which on a multi-user machine would let
 *  someone else list what an agent fetched or plant a symlink under it. */
const DOWNLOAD_PREFIX = 'zas-agent-';

/** A Firestore auto-id is alphanumeric, and every id the agent ever sees came
 *  from one. Anything else is a caller mistake, and building a reference out of
 *  it would name a different document — so it never reaches the query.
 *  Firestore reserves names that begin `__`, so `__proto__` — which a caller
 *  that read an id off a plain object hands over sooner or later — would
 *  travel and come back a 400 where "not in this channel" is the answer. */
const ID_SEGMENT = /^(?!__)[A-Za-z0-9_-]{1,128}$/;

/** More chunks than any file a coding agent fetches, and few enough that the
 *  serial redeem loop cannot be turned into thousands of round trips by a
 *  manifest another member sealed. */
const MAX_CHUNKS = 8192;

/** How many ` (n)` names a download tries before it gives up. A hundred copies
 *  of one file in one directory is a caller looping over a mistake, and the
 *  hundred-and-first is better refused than added to the pile. */
const MAX_DUPLICATES = 100;

export interface ItemSummary {
  id: string;
  kind: 'file' | 'text';
  title: string;
  name: string;
  mime: string;
  size: number;
  created_at: string;
  /** An agent — this one or another — put it there. Absent `agent` field on
   *  the row means a person's device did. */
  by_agent: boolean;
  /** Notes only: the body. A file's bytes are not in the manifest. */
  text?: string;
}

// ---- Firestore REST values ----
//
// runQuery answers documents whose every field is wrapped in a one-key object
// naming its type. Only five shapes appear on a links row, so the decoder is
// five lines rather than a dependency.

interface FirestoreValue {
  stringValue?: unknown;
  booleanValue?: unknown;
  timestampValue?: unknown;
  nullValue?: unknown;
}

interface LinkRow {
  id: string;
  manifestEnc?: string;
  /** The agent uid that sent it, when one did. */
  agent?: string;
  createdAt: number | null;
  /** null is not "unknown": it is a pin, which never departs. */
  expiresAt: number | null;
  bar: boolean;
}

function stringOf(value: FirestoreValue | undefined): string | undefined {
  return typeof value?.stringValue === 'string' ? value.stringValue : undefined;
}

function timeOf(value: FirestoreValue | undefined): number | null {
  const parsed = typeof value?.timestampValue === 'string' ? Date.parse(value.timestampValue) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function rowOf(doc: unknown): LinkRow {
  const document = (doc ?? {}) as { name?: unknown; fields?: unknown };
  const name = typeof document.name === 'string' ? document.name : '';
  const fields = (document.fields && typeof document.fields === 'object'
    ? document.fields
    : {}) as Record<string, FirestoreValue | undefined>;
  return {
    id: name.slice(name.lastIndexOf('/') + 1),
    manifestEnc: stringOf(fields.manifest_enc),
    agent: stringOf(fields.agent),
    createdAt: timeOf(fields.created_at),
    expiresAt: timeOf(fields.expires_at),
    bar: fields.bar?.booleanValue === true,
  };
}

/** A row there is nothing to read. A burn deletes the links document outright
 *  and tombstones the share, so in practice the missing ciphertext is what
 *  catches a consumed item; `bar` is checked as well because a tombstone that
 *  kept its row would otherwise list as an item with no bytes. An expired row
 *  is dropped for the same reason the feed drops it (Main.tsx:1412): the
 *  sweeper has not come round yet, but the item is gone. */
function readable(row: LinkRow): boolean {
  if (!row.id || row.bar || !row.manifestEnc) return false;
  return row.expiresAt === null || row.expiresAt > Date.now();
}

/** Bytes someone else sealed. A manifest that will not open is not an error to
 *  report: a member's client skips the same row, because the only honest
 *  reading is that this key was never meant to open it. */
function openFor(channelKey: Uint8Array, row: LinkRow): Manifest | null {
  try {
    return openManifest(channelKey, b64ToBytes(row.manifestEnc!));
  } catch {
    return null;
  }
}

function summaryOf(row: LinkRow, manifest: Manifest): ItemSummary {
  // Every other kind reads as a file, which is what the web does with one it
  // does not recognise: text is the special case, and everything else has bytes.
  const kind = manifest.kind === 'text' ? 'text' : 'file';
  const name = typeof manifest.name === 'string' ? manifest.name : '';
  return {
    id: row.id,
    kind,
    // Absence means "show the file name": the sender chose no title.
    title: manifest.title ?? name,
    name,
    mime: typeof manifest.mime === 'string' ? manifest.mime : 'application/octet-stream',
    size: typeof manifest.size === 'number' ? manifest.size : 0,
    // The sealed time is the sender's own; the row's is the server's, and it
    // only answers for a manifest that carries none.
    created_at: typeof manifest.created_at === 'string' && manifest.created_at
      ? manifest.created_at
      : row.createdAt !== null ? new Date(row.createdAt).toISOString() : '',
    by_agent: row.agent !== undefined,
    ...(kind === 'text' ? { text: manifest.text ?? '' } : {}),
  };
}

/** The grant the caller meant. `view` is a permission on sending, not on
 *  reading: a view-only member reads the channel, and so does its agent. */
async function readGrant(ctx: SendContext, channel: string | undefined): Promise<RemoteGrant> {
  const grant = resolveChannel(ctx.identity, await grantsFor(ctx.client, ctx.profile), channel);
  if (!grant.read) throw new ZasError('read_forbidden', 403);
  return grant;
}

/** The channel's name from the key already in hand. `channelNameOf` would
 *  unwrap the grant a second time, and a listing has no reason to do the
 *  X25519 twice; the failure is the same one it reports. */
function nameFrom(channelKey: Uint8Array, grant: RemoteGrant): string {
  try {
    return decryptChannelName(channelKey, b64ToBytes(grant.name_enc));
  } catch {
    throw new ZasError('key_stale', 0);
  }
}

function linksParent(identity: Identity, grant: RemoteGrant): string {
  return `accounts/${identity.owner_uid}/channels/${grant.channel_id}`;
}

/** The document reference `__name__` is compared against: a full resource
 *  path, host excluded. */
function linkPath(identity: Identity, grant: RemoteGrant, id: string): string {
  return `projects/${identity.firestore_project}/databases/(default)/documents`
    + `/${linksParent(identity, grant)}/links/${id}`;
}

async function queryLinks(ctx: SendContext, grant: RemoteGrant, query: object): Promise<unknown[]> {
  try {
    return await ctx.client.firestoreRunQuery(linksParent(ctx.identity, grant), query);
  } catch (err) {
    // Firestore says PERMISSION_DENIED, which errorFromResponse cannot name
    // because the body is Google's shape, not ours. On this path a 403 has one
    // cause: the owner switched `read` off after the grant cache was filled.
    if (err instanceof ZasError && err.status === 403) throw new ZasError('read_forbidden', 403);
    throw err;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

export async function listItems(
  ctx: SendContext,
  channel: string | undefined,
  limit?: number,
): Promise<{ channel_id: string; channel_name: string; items: ItemSummary[] }> {
  const grant = await readGrant(ctx, channel);
  const channelKey = channelKeyOf(ctx.identity, grant);
  const docs = await queryLinks(ctx, grant, {
    from: [{ collectionId: 'links' }],
    orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
    limit: clampLimit(limit),
  });

  const items: ItemSummary[] = [];
  for (const doc of docs) {
    const row = rowOf(doc);
    if (!readable(row)) continue;
    const manifest = openFor(channelKey, row);
    if (!manifest) continue;
    items.push(summaryOf(row, manifest));
  }
  return {
    channel_id: grant.channel_id,
    channel_name: nameFrom(channelKey, grant),
    items,
  };
}

/** What a refused redeem means. Only a real refusal is the capability's fault.
 *  A 429 is the server asking for a pause and a 5xx is the server being ill:
 *  both would otherwise tell the owner to open Zas and rewrite the manifest,
 *  a cure that fixes neither, when a retry would have worked. */
function redeemFailure(status: number): ZasError {
  if (status === 429) return new ZasError('rate_limited', 429);
  if (status >= 500) return new ZasError('network', status);
  return new ZasError('invalid_cap', 403);
}

/** One chunk, plaintext. The cap in the manifest is the whole authority: the
 *  redeem route is public and takes nothing else. There is no refresh — the
 *  web has none either, and a cap the server refuses is simply a chunk nobody
 *  can read until its owner opens Zas and the manifest is written again. */
async function fetchChunk(ctx: SendContext, chunk: ManifestChunk): Promise<Uint8Array> {
  if (typeof chunk.cap !== 'string' || chunk.cap === '') throw new ZasError('invalid_cap', 403);
  // Presented for the same reason the browser presents it: an organization's
  // objects re-check live membership before the storage URL is issued, and a
  // personal object ignores the header entirely. A session that will not
  // refresh is not fatal here — the call is public.
  let headers: Record<string, string> = {};
  try {
    headers = { Authorization: `Bearer ${await ctx.client.idToken()}` };
  } catch {
    headers = {};
  }

  let url: string;
  try {
    const redeemed = await apiPublic<{ url?: unknown }>(
      ctx.identity.api_base, 'POST', '/v1/blobs/redeem', { cap: chunk.cap }, headers,
    );
    url = typeof redeemed.url === 'string' ? redeemed.url : '';
  } catch (err) {
    // The status decides. A thrown fetch is the network's problem and must
    // keep saying so.
    if (err instanceof ZasError) throw redeemFailure(err.status);
    throw err;
  }
  // A 200 with no URL is a refusal in every way that matters here.
  if (url === '') throw new ZasError('invalid_cap', 403);

  const res = await fetch(url);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw res.status >= 500 ? new ZasError('network', res.status) : new ZasError('invalid_cap', 403);
  }
  const ciphertext = new Uint8Array(await res.arrayBuffer());
  try {
    return decryptChunk(b64ToBytes(chunk.key), b64ToBytes(chunk.nonce), ciphertext);
  } catch {
    // The manifest and the object disagree. The bytes are unusable and the cap
    // is the only thing that named them, so it is the cap that is wrong.
    throw new ZasError('invalid_cap', 403);
  }
}

/** The file name, reduced to something that cannot leave the directory it is
 *  written into. `manifest.name` was chosen on another machine. */
function safeName(name: unknown, fallback: string): string {
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop() ?? '';
  return base.replace(/^\.+/, '').trim() || fallback;
}

/** A name with nothing standing on it. `renameSync` replaces whatever is at the
 *  target, so a download is one keystroke away from destroying the caller's own
 *  file: `dest: "README.md"` from an agent sitting in a repository would report
 *  success over the wreckage. Instead the download steps aside — `informe
 *  (1).txt` — the way a browser's downloads folder taught everyone to read, and
 *  the caller is told in `{ path }` where the bytes actually went. */
function freeName(target: string): string {
  if (!existsSync(target)) return target;
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let n = 1; n <= MAX_DUPLICATES; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new ZasError('write_failed', 0, target);
}

/** The file the bytes are written to. A destination that is already a
 *  directory means "put it in here", which is the natural reading of
 *  `dest: "./downloads"` and the alternative to a rename that fails with
 *  EISDIR. With no destination at all, a private directory made for this one
 *  call: two downloads of the same file name never meet. `created` names that
 *  directory, and only that one, so a download that fails can take it away
 *  again instead of leaving an empty `zas-agent-*` behind per failure. */
function destinationOf(
  dest: string | undefined,
  name: unknown,
  fallback: string,
): { target: string; created?: string } {
  const base = safeName(name, fallback);
  if (dest === undefined) {
    // The directory was made a moment ago and holds nothing, so `freeName` can
    // only answer the name itself. It is asked anyway: one rule, one place.
    const created = mkdtempSync(join(tmpdir(), DOWNLOAD_PREFIX));
    return { target: freeName(join(created, base)), created };
  }
  const at = statSync(dest, { throwIfNoEntry: false })?.isDirectory() ? join(dest, base) : dest;
  return { target: freeName(at) };
}

export async function getItem(
  ctx: SendContext,
  channel: string | undefined,
  id: string,
  dest?: string,
): Promise<{ path?: string; text?: string; bytes: number }> {
  const grant = await readGrant(ctx, channel);
  if (!ID_SEGMENT.test(id)) throw new ZasError('not_found', 404);
  const channelKey = channelKeyOf(ctx.identity, grant);
  const docs = await queryLinks(ctx, grant, {
    from: [{ collectionId: 'links' }],
    where: {
      fieldFilter: {
        field: { fieldPath: '__name__' },
        op: 'EQUAL',
        value: { referenceValue: linkPath(ctx.identity, grant, id) },
      },
    },
    limit: 1,
  });

  const row = docs.length > 0 ? rowOf(docs[0]) : null;
  if (!row || !readable(row)) throw new ZasError('not_found', 404);
  const manifest = openFor(channelKey, row);
  // Gone, consumed, or sealed for a key this agent does not hold: from here
  // they are one answer, and naming which would tell the caller something
  // about a channel it cannot read.
  if (!manifest) throw new ZasError('not_found', 404);

  if (manifest.kind === 'text') {
    const text = manifest.text ?? '';
    return { text, bytes: new TextEncoder().encode(text).length };
  }

  // Everything that reaches here is read as a file — the text kind returned
  // above — and a file with no chunks has no bytes anywhere. It is the shape
  // `openManifest` manufactures for a manifest that arrived without a usable
  // list, and `manifest.size` does not always catch it: absent or not a number,
  // it reads as 0 and the check below stands down. A 0-byte file handed back as
  // the item is the worse answer, so the row is gone as far as the caller goes.
  if (manifest.chunks.length === 0) throw new ZasError('not_found', 404);

  // A manifest is sealed by another member, not by the server, so its length
  // is a claim and not a fact. Refused before the first round trip.
  if (manifest.chunks.length > MAX_CHUNKS) throw new ZasError('not_found', 404);

  // In order, one at a time, straight to disk. A coding agent fetches a file it
  // is about to read, not a video library, and a serial loop holds one chunk's
  // plaintext at a time instead of the whole file. Written the way the identity
  // file is — 0600, through a temporary name — so no other account on the
  // machine reads what was fetched and no half file appears under the name the
  // caller was told to open.
  let target: string | undefined;
  let created: string | undefined;
  let tmp: string | undefined;
  let fd: number | undefined;
  let written = 0;
  try {
    const chosen = destinationOf(dest, manifest.name, row.id);
    target = chosen.target;
    created = chosen.created;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    fd = openSync(tmp, 'wx', 0o600);
    for (const chunk of manifest.chunks) {
      // The count comes from the write, not from the chunk: a short write is
      // then a size mismatch below rather than a silently truncated file.
      written += writeSync(fd, await fetchChunk(ctx, chunk));
    }
    // The manifest said how big the file is. Anything else — a truncated
    // manifest, or the `chunks: []` that openManifest supplies for one that
    // arrived without a usable list — is not the item, and handing back an
    // empty file the caller would read as the item is the worse answer.
    const size = typeof manifest.size === 'number' ? manifest.size : 0;
    if (size > 0 && written !== size) throw new ZasError('not_found', 404);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } catch (err) {
    // A refused cap, a rate limit, a short manifest: those already say what
    // happened. The filesystem is renamed — EISDIR, EPERM, ENOTDIR, EACCES,
    // ENAMETOOLONG — because the caller deserves a sentence rather than an
    // errno with a path in it. What names one is the errno shape Node puts on
    // it, `syscall` and `errno`, and not `code`: `ZasError` carries a `code`
    // too, and so do plenty of other libraries, so `code` alone would rename a
    // refused capability into a disk failure the day a `ZasError` crossed a
    // module boundary and lost its identity. What is left is a thrown
    // `fetch`: no status, no errno, and a bare TypeError at a terminal names
    // nothing the owner can act on — the sentence is the network's, and the
    // original message rides along for the bug report.
    if (err instanceof ZasError) throw err;
    const failure = err as NodeJS.ErrnoException;
    if (typeof failure.syscall === 'string' || typeof failure.errno === 'number') {
      throw new ZasError('write_failed', 0, failure.message);
    }
    throw new ZasError('network', 0, String((err as Error)?.message ?? err));
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
    // After the rename the temporary is the target; after anything else it
    // holds plaintext nobody asked to keep.
    if (tmp !== undefined && existsSync(tmp)) try { unlinkSync(tmp); } catch { /* nothing to undo */ }
    // And the directory this call made for a download that never landed in it.
    // `rmdir` refuses one that still holds the file, so the successful case
    // needs no test of its own.
    if (created !== undefined) try { rmdirSync(created); } catch { /* the file is in it */ }
  }
  return { path: target, bytes: written };
}
