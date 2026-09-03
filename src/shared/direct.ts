// Directo: a channel flipped from storage to tunnel. Files sent while the
// flag is on travel device-to-device over a WebRTC data channel; the server
// coordinates the handshake and stores nothing but sealed envelopes.
//
// Everything here is decidable without I/O — the client mirrors these rules
// to decide what to offer, the API applies them to decide what to accept,
// and the unit tests pin them so the two can never drift.
import type { ChannelMode } from './constants.js';

/** An unclaimed offer dies on its own; ten minutes is long enough to walk to
 *  the other device and short enough that a forgotten one never greets you
 *  tomorrow. This clock measures the wait for a claim, never the transfer —
 *  claiming moves the doc to DIRECT_CLAIMED_TTL_MS. */
export const DIRECT_OFFER_TTL_MS = 10 * 60 * 1000;

/** A claimed exchange is two devices mid-transfer, and a big file on a slow
 *  pair takes hours, not minutes. Six hours matches the life of the TURN
 *  credential the /ice route mints, so the doc's lease never promises more
 *  time than the relay can deliver. */
export const DIRECT_CLAIMED_TTL_MS = 6 * 60 * 60 * 1000;

/** A finished transfer leaves a receipt, not an item. The receipt's whole job
 *  is to be seen once and go away; GC takes it with the next sweep. */
export const DIRECT_DONE_TTL_MS = 15 * 1000;

/** The most one offer carries. Twenty gigabytes is what the claimed lease can
 *  actually move at a modest ~1 MB/s — past this the transfer clock runs out
 *  before the file does, so the refusal happens up front instead of at hour
 *  six. The server never learns a size (meta rides sealed), so this cap lives
 *  at the two ends: the sender refuses to offer, the receiver refuses the
 *  meta frame of a sender that did not. */
export const DIRECT_FILE_MAX_BYTES = 20 * 1024 * 1024 * 1024;

/** Free accounts get a smaller Direct allowance. The wire protocol keeps its
 *  20 GiB safety ceiling for paid accounts and for receivers, while senders
 *  use this plan-aware limit before publishing an offer. Unknown plans fail
 *  closed to Free, like the other plan limits. */
export const DIRECT_FREE_FILE_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const DIRECT_ANON_FILE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/** Organization-bound offers may exceed the personal safety ceiling: the
 *  admin-set directoMaxFileBytes (up to 100 GiB) is enforced at admission,
 *  and this is the wire-protocol ceiling backing it. */
export const DIRECT_ENTERPRISE_FILE_MAX_BYTES = 100 * 1024 * 1024 * 1024;

export function directFileLimitFor(plan: string | undefined): number {
  if (plan === 'anon') return DIRECT_ANON_FILE_MAX_BYTES;
  return plan === 'pro' || plan === 'max'
    ? DIRECT_FILE_MAX_BYTES
    : DIRECT_FREE_FILE_MAX_BYTES;
}

/** Data-channel frame payload. 64 KiB is the ceiling every browser's SCTP
 *  implementation accepts without fragmentation surprises. */
export const DIRECT_CHUNK_BYTES = 64 * 1024;

/** Stop reading the file while the data channel holds more than this;
 *  resume on bufferedamountlow. Keeps memory flat on a fast disk + slow net. */
export const DIRECT_BUFFERED_HIGH = 8 * 1024 * 1024;

/** Protocol-v2 receive window. The sender does not read the next window until
 *  the receiver has persisted this one, bounding the application queue even
 *  when a fast network feeds a slow disk. */
export const DIRECT_RECEIVE_WINDOW_BYTES = 4 * 1024 * 1024;

/** Browsers without a streaming save-file sink must hold the completed Blob
 *  in memory. Keep that compatibility path deliberately small; advertising
 *  the 20 GiB wire cap there would turn a successful transfer into a killed
 *  tab on phones and lower-memory desktops. */
export const DIRECT_MEMORY_SINK_MAX_BYTES = 128 * 1024 * 1024;

/** Reliable delivery after a live Direct attempt fails. The browser encrypts
 *  independently authenticated parts and uploads them to temporary R2
 *  storage. Sixteen MiB keeps encryption memory modest on phones while every
 *  non-final multipart part remains comfortably above S3's 5 MiB minimum. */
export const DIRECT_FALLBACK_PART_BYTES = 16 * 1024 * 1024;
export const DIRECT_FALLBACK_TAG_BYTES = 16; // AES-GCM authentication tag
export const DIRECT_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

export type DirectFallbackState = 'uploading' | 'ready' | 'received' | 'failed';

export function directFallbackPartCount(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('bad_size');
  return Math.max(1, Math.ceil(size / DIRECT_FALLBACK_PART_BYTES));
}

export function directFallbackCipherSize(size: number): number {
  return size + directFallbackPartCount(size) * DIRECT_FALLBACK_TAG_BYTES;
}

/** From the peer's first signal to an open data channel. Fifteen seconds
 *  looked generous until production showed a phone on cellular through the
 *  relay connecting at fourteen — and timing out at fifteen three tries in a
 *  row. Thirty covers the slow-yes; a handshake still pending past that is
 *  not going to finish, and the storage path takes over. Also the window a
 *  mid-flight ICE restart gets to reconnect (the receiver waits twice this,
 *  so the restarting sender always gives up first). */
export const DIRECT_CONNECT_TIMEOUT_MS = 30 * 1000;

/** How long `disconnected` may last before the engine acts on it. Wi-Fi
 *  hiccups produce `disconnected` and recover on their own; past this the
 *  sender opens a fresh handshake (ICE restart) over the signal bus — the
 *  DTLS/SCTP association under the data channel survives the rebind, so the
 *  file resumes where it stopped. Production's reason for existing: carrier
 *  NAT rebinds killed three phone transfers at nine-to-ten minutes, one of
 *  them within sight of its last byte. */
export const DIRECT_STALL_GRACE_MS = 5 * 1000;

/** How long an engine waits for the peer to say anything at all. A phone
 *  that backgrounded its tab needs its human to bring it back before it can
 *  speak — that is a person's clock, not ICE's, so it gets minutes where the
 *  connect clock gets seconds. A peer still silent past this was never
 *  coming: the session fails as `peer_silent`. */
export const DIRECT_SIGNAL_WAIT_MS = 90 * 1000;

export type DirectState = 'open' | 'claimed' | 'done' | 'failed' | 'cancelled';
export type DirectActor = 'sender' | 'claimant';

export interface DirectEndpoints {
  sender?: string;
  senderDevice?: string;
  claimedBy?: string;
  claimedDevice?: string;
}

/** Maps an authenticated tab to one endpoint. Both account identity and the
 *  random per-tab token must match: channel membership alone never grants the
 *  right to speak for another live transfer. */
export function directActorFor(
  endpoints: DirectEndpoints,
  uid: string,
  device: string,
): DirectActor | null {
  if (endpoints.sender === uid && endpoints.senderDevice === device) return 'sender';
  if (endpoints.claimedBy === uid && endpoints.claimedDevice === device) return 'claimant';
  return null;
}

/** TURN and signaling exist only for a claimed, unexpired exchange. */
export function directExchangeLive(state: DirectState, expiresAtMs: number, now: number): boolean {
  return state === 'claimed' && Number.isFinite(expiresAtMs) && expiresAtMs > now;
}

/** Who may flip a channel between storage and tunnel. The same truth table as
 *  `canWrite` in functions/src/sharedchannel.ts — flipping changes what a send
 *  does, so it belongs to exactly the people whose sends it would change. */
export function canFlipDirect(role: string | undefined, mode: ChannelMode): boolean {
  if (role === 'owner') return true;
  return role === 'member' && mode !== 'view';
}

/** The offer lifecycle. Claiming is the receiver's act alone (a sender
 *  "claiming" their own offer would deadlock the handshake); cancelling an
 *  unclaimed offer is the sender's alone (nobody else owns it yet). Once
 *  claimed, either side may end it — a transfer takes two, so either walking
 *  away ends it. Terminal states stay terminal: a retry is a new offer, never
 *  a resurrected one, so a stale tab replaying old signals cannot reopen a
 *  finished exchange. One demotion between dead states is allowed: the sender
 *  resolving a failed offer (retry or the storage fallback) folds it into
 *  cancelled, so every tab drops the row instead of showing the corpse for
 *  the rest of its TTL. */
export function directTransitionOk(from: DirectState, to: DirectState, actor: DirectActor): boolean {
  if (from === 'open' && to === 'claimed') return actor === 'claimant';
  if (from === 'open' && to === 'cancelled') return actor === 'sender';
  if (from === 'claimed') return to === 'done' || to === 'failed' || to === 'cancelled';
  if (from === 'failed' && to === 'cancelled') return actor === 'sender';
  return false;
}

/** How long a doc entering `state` has left to live. Every write that changes
 *  state restamps `expires_at` from this table — the routes, the client's
 *  expiry filter and GC all read one clock, so none of them can disagree
 *  about when a row is dead. Waiting states get the walk-to-the-device
 *  window (a failure keeps the sender's retry/fallback buttons up for the
 *  same ten minutes a fresh offer would stand); a claimed exchange gets the
 *  transfer window; receipts and cancellations just wait for the sweep. */
export function directLeaseMs(state: DirectState): number {
  if (state === 'claimed') return DIRECT_CLAIMED_TTL_MS;
  if (state === 'done' || state === 'cancelled') return DIRECT_DONE_TTL_MS;
  return DIRECT_OFFER_TTL_MS; // open, failed
}

/** Whether a feed still shows a row at `now`. Cancelled rows never stand —
 *  the other end resolved them. Past `expires_at` a row stands only while
 *  this device is mid-transfer on it: the wall clock must never bury a
 *  moving progress bar (skew, or a doc the server already re-leased). An
 *  `expiresAtMs` of 0 is a server timestamp still resolving; the row stands
 *  on trust for the moment the estimate takes to land. */
export function directRowStands(
  state: DirectState,
  expiresAtMs: number,
  now: number,
  liveRun: boolean,
): boolean {
  if (state === 'cancelled') return false;
  return liveRun || expiresAtMs === 0 || expiresAtMs > now;
}
