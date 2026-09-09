// An agent changes what it already sent, under the same item id. Two
// operations: the sealed manifest re-written (a title, a note's text) and,
// for a file, the bytes under it swapped by the server. Both read the item
// first — the update time that read returned is the guard the server checks,
// so a change that lands over somebody else's is refused instead of lost —
// and both refuse an item this agent did not send: "its own items" is the
// whole permission, and the server's `not_allowed` says the same thing.
//
// The server reads no manifest here either. What it sees on an edit is a new
// sealed blob under the old id; on a replace, that plus the chunk ids the caps
// name, exactly what a send shows it.
import { agentSendIdempotencyKey } from './shared/agent.js';
import { blake3Hex, bytesToB64 } from './shared/hash.js';
import { newManifest, sealManifest, type Manifest } from './shared/manifest.js';
import { ZasError } from './errors.js';
import { channelNameOf } from './grants.js';
import type { RemoteGrant } from './identity.js';
import { loadItem, type LoadedItem } from './read.js';
import {
  checkFilePath, forgetLink, mimeFor, noteName, placeFile, readFileChecked,
  type SendContext, type SendPhase, type SendResult,
} from './send.js';
import { thumbnailFor } from './thumbnail.js';

export interface EditItemInput {
  id: string;
  channel?: string;
  /** `''` clears the title, so the file name or the first line shows again. */
  title?: string;
  text?: string;
  /** `''` makes the note plain text again. */
  lang?: string;
  secret?: boolean;
}

export interface ReplaceFileInput { id: string; channel?: string; path: string; title?: string }

export interface EditResult {
  link_id: string;
  channel_id: string;
  channel_name: string;
  kind: 'text' | 'file';
  /** What the item shows now: the title, or the name it falls back to. */
  title: string;
  /** The row's update time after the write, in milliseconds. */
  update_time: number;
}

/** The other half of the grant an edit needs. `loadItem` refused one that
 *  cannot read; the change is a send, so the send rules apply too, in the
 *  order `sendFile` says them. */
function writable(grant: RemoteGrant): void {
  if (!grant.send || grant.mode === 'view') throw new ZasError('send_forbidden', 403);
  if (grant.direct_mode) throw new ZasError('direct_mode', 409);
}

/** The item, opened, and this agent's to change. The row's `agent` is the
 *  server's word on who sent it — the manifest says nothing about that — and
 *  the server would refuse the write anyway; checked here so the refusal
 *  costs no request and arrives as the closed code. */
async function ownItem(ctx: SendContext, channel: string | undefined, id: string): Promise<LoadedItem> {
  const loaded = await loadItem(ctx, channel, id);
  writable(loaded.grant);
  if (loaded.row.agent !== ctx.identity.agent_uid) throw new ZasError('not_yours', 403);
  return loaded;
}

function sealedFor(item: LoadedItem, manifest: Manifest): string {
  return bytesToB64(sealManifest(item.channelKey, manifest, item.grant.key_version));
}

/** The guard, when the read produced one. A row without an update time is
 *  not one this protocol wrote; it goes unguarded, which is the old rule. */
function guardOf(item: LoadedItem): { expected_update_time: number } | Record<string, never> {
  return item.row.updateTime === null ? {} : { expected_update_time: item.row.updateTime };
}

export async function editItem(ctx: SendContext, input: EditItemInput): Promise<EditResult> {
  const item = await ownItem(ctx, input.channel, input.id);
  const { grant, row, manifest } = item;
  const kind = manifest.kind === 'text' ? 'text' : 'file';
  const noteFields = input.text !== undefined || input.lang !== undefined || input.secret !== undefined;
  if (noteFields && kind !== 'text') throw new ZasError('not_a_note', 400);
  const done = (updateTime: number): EditResult => ({
    link_id: row.id,
    channel_id: grant.channel_id,
    channel_name: channelNameOf(ctx.identity, grant),
    kind,
    title: manifest.title ?? manifest.name,
    update_time: updateTime,
  });
  // Nothing asked is nothing written: no row in the owner's log for a call
  // that changed nothing.
  if (input.title === undefined && !noteFields) return done(row.updateTime ?? Date.now());

  if (input.title !== undefined) {
    if (input.title === '') delete manifest.title;
    else manifest.title = input.title;
  }
  if (input.text !== undefined) {
    manifest.text = input.text;
    manifest.size = new TextEncoder().encode(input.text).length;
    // A rendering of the old text is not a rendering of the new one.
    delete manifest.html;
    // The row label follows the first line, as a send derives it, unless the
    // sender chose a title — which is the label.
    if (manifest.title === undefined) manifest.name = noteName(input.text);
  }
  if (input.lang !== undefined) {
    if (input.lang === '') delete manifest.code;
    else manifest.code = { lang: input.lang, auto: false };
  }
  if (input.secret !== undefined) {
    // Only ever true or absent, as the note cover is defined.
    if (input.secret) manifest.sensitive = true;
    else delete manifest.sensitive;
  }
  const answer = await ctx.client.api<{ ok: boolean; update_time?: number }>(
    'PATCH', `/links/${grant.channel_id}/${row.id}`, {
      manifest_enc: sealedFor(item, manifest),
      // The caller is changing what the item says: the server records it.
      edit: true,
      ...guardOf(item),
    },
  );
  // "Send that again" after an edit makes a new item, not the edited one.
  forgetLink(ctx.profile, row.id);
  return done(typeof answer.update_time === 'number' ? answer.update_time : Date.now());
}

export async function replaceFile(
  ctx: SendContext,
  input: ReplaceFileInput,
  onPhase?: (phase: SendPhase) => void,
): Promise<SendResult> {
  // The path first, as a send does: a mistyped one costs no request.
  await checkFilePath(input.path);
  const item = await ownItem(ctx, input.channel, input.id);
  const { grant, row, manifest } = item;
  if (manifest.kind === 'text') throw new ZasError('not_a_file', 400);
  const { bytes, name } = await readFileChecked(input.path);
  const title = input.title ?? manifest.title;
  const contentHash = await blake3Hex(bytes);

  const placed = await placeFile(ctx, bytes, onPhase);

  onPhase?.('finishing');
  const mime = mimeFor(input.path);
  const thumb = await thumbnailFor(bytes, mime);
  const next = newManifest({
    kind: 'file',
    name,
    ...(title !== undefined ? { title } : {}),
    mime,
    size: bytes.length,
    // The item's own time: a replace changes what the item holds, not when the
    // owner got it, and the row keeps its place in the channel either way.
    created_at: manifest.created_at || new Date().toISOString(),
    ...(thumb ? { thumb_data: thumb } : {}),
    chunks: placed.map((p) => p.entry),
  });
  // The caps in the manifest this agent read are the ones bound to the link:
  // the only proof the server takes that this link held those chunks.
  const release = manifest.chunks.map((c) => c.cap).filter((cap): cap is string => typeof cap === 'string');
  const answer = await ctx.client.api<{
    ok: boolean; caps?: Record<string, string>; update_time?: number; replayed?: boolean;
  }>('POST', `/links/${grant.channel_id}/${row.id}/replace`, {
    manifest_enc: sealedFor(item, next),
    caps: placed.map((p) => p.entry.cap).filter((cap): cap is string => typeof cap === 'string'),
    release,
    // Scoped to the link as well as the channel: the same bytes sent as a new
    // item are a different request from these bytes replacing this one.
    idempotency_key: agentSendIdempotencyKey(`${grant.channel_id}/${row.id}`, contentHash, title ?? name),
    ...guardOf(item),
  });

  // The bound caps go in exactly as after a send — and without `edit`, so the
  // owner's log holds one `replace` row and not a `replace` and an `edit`.
  // `next.chunks` are the same objects as `placed[i].entry`.
  const bound = answer.caps ?? {};
  let patched = false;
  for (const p of placed) {
    const cap = bound[p.entry.blob_id];
    if (cap) {
      p.entry.cap = cap;
      patched = true;
    }
  }
  if (patched) {
    await ctx.client.api('PATCH', `/links/${grant.channel_id}/${row.id}`, { manifest_enc: sealedFor(item, next) });
  }
  forgetLink(ctx.profile, row.id);
  return {
    link_id: row.id,
    channel_id: grant.channel_id,
    channel_name: channelNameOf(ctx.identity, grant),
    bytes: bytes.length,
    chunks: placed.length,
    deduplicated: placed.filter((p) => p.proven).length,
    replayed: answer.replayed === true,
  };
}
