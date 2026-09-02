// Pinned protocol constants. Changing any of these is a breaking protocol change.

export const CHUNKER_VERSION = 'chunker_v1';
export const CHUNK_MIN = 1 * 1024 * 1024; // 1 MiB
export const CHUNK_AVG_BITS = 22; // 4 MiB average
export const CHUNK_MAX = 8 * 1024 * 1024; // 8 MiB
/** Storage v2 uses fixed parts. This keeps a 20 GiB manifest below Firestore's
 *  document limit while the browser holds only one part at a time. */
export const STORAGE_V2_PART_BYTES = 16 * 1024 * 1024;
export const GEAR_SEED = 'zas-gear-v1:';

export const HKDF_INFO_CHUNK_KEY = 'zas-chunk-key-v1';
export const HKDF_INFO_CHUNK_NONCE = 'zas-chunk-nonce-v1';
export const HKDF_INFO_CHANNEL_PREFIX = 'channel:';

// RFC 9497 OPRF, mode 0x00, ristretto255-SHA512
export const OPRF_CONTEXT = 'OPRFV1-\x00-ristretto255-SHA512';

export const MANIFEST_VERSION = 1;
export const DISCLOSURE_VERSION = 1;

export const EXPIRY_DAYS = 5;

/** An anonymous session's items. Shorter than an account's five days: the
 *  session is meant to be a hand-off, not a home. */
export const ANON_EXPIRY_DAYS = 2;

/** How long a session with nothing in it survives. Adding an item pushes the
 *  session out to that item's own expiry, so this only ever ends the sessions
 *  nobody used. */
export const ANON_EMPTY_TTL_MS = 30 * 60 * 1000;
/** One segment per day of an account's life, so a full ring is a full life.
 *  Tied to EXPIRY_DAYS on purpose: the lit count equals the number in the
 *  label (spec §6.2), and a ring that cannot fill would read as time already
 *  spent. Moving EXPIRY_DAYS without moving this is what breaks that. */
export const RING_SEGMENTS = 5;
export const FREE_RELAY_MAX_BYTES = 50 * 1024 * 1024; // Free: unique file via relay <= 50 MB

/** Temporary maximum size for one stored item while the v1 finalization path
 *  uses one Firestore transaction for every chunk. A FastCDC chunk can be as
 *  small as 1 MiB. Keeping paid items at 200 MiB keeps the worst-case write
 *  count below Firestore's 500-write transaction limit, including the account
 *  and link writes. The v2 upload-session path does not use this limit. */
export const SAFE_STORED_FILE_LIMITS: Record<string, number> = {
  anon: 30 * 1024 * 1024,
  free: FREE_RELAY_MAX_BYTES,
  pro: 200 * 1024 * 1024,
  max: 200 * 1024 * 1024,
};

/** Product limits for the item-owned v2 path. Paid plans are not sold yet,
 *  but the values keep current native plan constants and server policy aligned
 *  for internal accounts. */
export const STORED_FILE_LIMITS_V2: Record<string, number> = {
  anon: 30 * 1024 * 1024,
  free: FREE_RELAY_MAX_BYTES,
  pro: 5 * 1024 * 1024 * 1024,
  max: 20 * 1024 * 1024 * 1024,
};

/** Unknown plans fail closed to the Free limit. */
export function safeStoredFileLimitFor(plan: string | undefined): number {
  const key = plan && Object.prototype.hasOwnProperty.call(SAFE_STORED_FILE_LIMITS, plan) ? plan : 'free';
  return SAFE_STORED_FILE_LIMITS[key];
}

/** Unknown v2 plans fail closed to the Free product limit. */
export function storedFileLimitV2For(plan: string | undefined): number {
  const key = plan && Object.prototype.hasOwnProperty.call(STORED_FILE_LIMITS_V2, plan) ? plan : 'free';
  return STORED_FILE_LIMITS_V2[key];
}

/** How many items a plan may keep pinned at once. `null` means no cap.
 *  Note this departs from spec §6.1/§8, which specify unlimited pins on every
 *  plan; the cap is a deliberate product decision made after that was written. */
export const PIN_LIMITS: Record<string, number | null> = {
  anon: 0,
  free: 15,
  pro: null,
  max: null,
};

export function pinLimitFor(plan: string | undefined, earned = 0): number | null {
  // Anything unrecognised falls back to the *most restrictive* plan. Writing
  // this as `PIN_LIMITS[plan ?? 'free'] ?? null` looked equivalent but sent an
  // empty-string plan to unlimited — a limit must never fail open.
  const key = plan && Object.prototype.hasOwnProperty.call(PIN_LIMITS, plan) ? plan : 'free';
  const limit = PIN_LIMITS[key];

  // Pro and max stay unlimited; free and unknown plans get a bonus from earned pins (clamped to 20)
  if (limit === null) return null;
  // A plan with no pins has no pins to earn either. Without this, an anonymous
  // session that somehow carried an `earned_pins` value would be handed pins
  // the plan does not have.
  if (limit === 0) return 0;
  const bonus = Math.min(Math.max(earned, 0), 20);
  return limit + bonus;
}

/** How many channels a plan may own at once, besides the default Private one.
 *  `null` means no cap. Joined (foreign) channels never count. */
export const CHANNEL_LIMITS: Record<string, number | null> = {
  anon: 0,
  free: 5,
  pro: null,
  max: null,
};

export function channelLimitFor(plan: string | undefined): number | null {
  // Same fail-closed rule as pinLimitFor: an unrecognised plan gets the most
  // restrictive limit — a cap must never fail open.
  const key = plan && Object.prototype.hasOwnProperty.call(CHANNEL_LIMITS, plan) ? plan : 'free';
  return CHANNEL_LIMITS[key];
}

/** Total bytes of live content a plan may hold. `null` means no cap.
 *  Counted per live item: the same file in two items counts twice. Manifests
 *  are encrypted, so the server only learns which blobs a link holds from the
 *  caps presented at creation — deduplicating across an account's items would
 *  mean retaining those ids on every link, which is metadata this design does
 *  not keep for a fairness counter. Storage itself is content-addressed and
 *  deduplicated regardless. */
export const STORAGE_LIMITS: Record<string, number | null> = {
  anon: 30 * 1024 * 1024,
  free: 100 * 1024 * 1024,
  pro: null,
  max: null,
};

export function storageLimitFor(plan: string | undefined): number | null {
  // Same fail-closed rule as pinLimitFor and channelLimitFor: an unrecognised
  // plan gets the free cap, never an uncapped one.
  const key = plan && Object.prototype.hasOwnProperty.call(STORAGE_LIMITS, plan) ? plan : 'free';
  return STORAGE_LIMITS[key];
}

/** Whether an account holding `used` bytes may add `bytes` more. `null` is an
 *  uncapped plan. Landing exactly on the cap is allowed; the byte past it is
 *  not. Lives here rather than in the server, because the client runs the same
 *  rule before an upload starts and the two must not drift apart. */
export function fitsInQuota(used: number, bytes: number, limit: number | null): boolean {
  if (limit === null) return true;
  return used + bytes <= limit;
}

/** What members of a shared channel may do. `view` is read and download and
 *  nothing else; `edit` is everything a member could do before this existed.
 *  The owner is never bound by it. */
export type ChannelMode = 'view' | 'edit';

/** Reads a channel's stored mode. Anything that is not exactly `'view'` is
 *  `'edit'` — including absent, which is what every channel shared before this
 *  feature carries, so none of them needs migrating. Fail-open is right here
 *  and only here: the field's absence means "nobody has restricted this", and
 *  reading a garbled value as `view` would silently freeze a working channel.
 *  Lives here rather than in the server because the client runs the same rule
 *  to decide what to offer, and the two must not drift apart. */
export function modeOf(raw: unknown): ChannelMode {
  return raw === 'view' ? 'view' : 'edit';
}

/** Thumbnail bounds shared by every client that writes `thumb_data` into a
 *  manifest: the longest edge in pixels and the data-URI budget in bytes. */
export const THUMBNAIL_MAX_EDGE = 640;
export const THUMBNAIL_MAX_BYTES = 140_000;
