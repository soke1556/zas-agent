// Zas Nearby (#35): the wire constants and codecs every client ports.
//
// Two people who are physically together share an item on purpose, by a
// Bluetooth touch (iOS and Android) or by a QR code (every client). The item
// moves through normal Zas storage into a two-person channel of kind
// `nearby`; the server never sees its key. docs/nearby.md has the full
// protocol. Everything here is pure, so each client can port it and check
// its port against the vectors in shared/test/nearby.test.ts.
import { sha256 } from '@noble/hashes/sha2';
import { b64ToBytes, bytesToB64, concatBytes, hmacSha256 } from './hash.js';
import { openRaw, sealRaw, type Manifest } from './manifest.js';

/** The Zas Nearby Bluetooth LE service a ready receiver advertises. */
export const NEARBY_SERVICE_UUID = '22f82ae9-beef-426a-b485-d88c5f9f33b7';
/** The GATT characteristic that returns the 32-byte carrier below. */
export const NEARBY_TOKEN_CHARACTERISTIC_UUID = '52eb7074-8fc1-4d5a-b000-8cb8eabbd725';
/** v2 is a separate characteristic, never inferred from its 32-byte value. */
export const NEARBY_TOKEN_V2_CHARACTERISTIC_UUID = '52eb7074-8fc1-4d5a-b000-8cb8eabbd726';
export type NearbyCarrierVersion = 1 | 2;

/** A receiver's touch token lives this long; the client replaces it first. */
export const NEARBY_TOKEN_TTL_MS = 120_000;
/** An offer with no answer by then counts as declined ("No answer"). */
export const NEARBY_OFFER_TTL_MS = 120_000;
/** A QR code stays claimable this long; the sender's client then gets a new one. */
export const NEARBY_CODE_TTL_MS = 300_000;

export const NEARBY_TOKEN_BYTES = 16;
export const NEARBY_FINGERPRINT_BYTES = 16;
export const NEARBY_CARRIER_BYTES = NEARBY_TOKEN_BYTES + NEARBY_FINGERPRINT_BYTES;
export const NEARBY_CODE_ID_BYTES = 16;

/** 16 random bytes in unpadded base64url: always 22 characters. */
export const NEARBY_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const NEARBY_CODE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Every refusal a nearby route can answer with. Each client shows each one
 *  with its own sentence; none of them means "check your connection". */
export const NEARBY_REFUSAL_CODES = [
  'nearby_token_expired',
  'nearby_self',
  'nearby_key_mismatch',
  'nearby_code_expired',
  'nearby_code_taken',
  'nearby_offer_expired',
  'nearby_delivery_not_ready',
  'nearby_delivery_conflict',
  'nearby_delivery_expired',
  'nearby_channel_exists',
  'nearby_channel_not_kept',
  'nearby_channel_closed_membership',
  'nearby_send_personal_only',
  // The copy into the nearby channel did not fit the sender's personal
  // storage (#43). Named so no client falls back to "try again".
  'storage_limit',
  'enterprise_sending_disabled',
  'enterprise_guest_receiving_disabled',
  'enterprise_plan_inactive',
  'rate_limited',
] as const;
export type NearbyRefusalCode = (typeof NEARBY_REFUSAL_CODES)[number];

/** A code as the public peek reports it. */
export type NearbyCodeState = 'open' | 'claimed' | 'done' | 'expired';

// ---- base64url, unpadded -------------------------------------------------

export function toB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('bad base64url');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  if (typeof atob !== 'undefined') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ---- touch: the Bluetooth carrier ----------------------------------------

/** The first 16 bytes of SHA-256 over the receiver's 32-byte assignment
 *  public key. The sender compares the key the server resolves against this,
 *  so a server that swapped the key would be caught at the touch. */
export function nearbyKeyFingerprint(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new Error('bad public key');
  return sha256(publicKey).slice(0, NEARBY_FINGERPRINT_BYTES);
}

/** The 32 bytes the GATT characteristic returns: `token (16) ‖ fingerprint (16)`. */
export function encodeNearbyCarrier(token: Uint8Array, publicKey: Uint8Array, version: NearbyCarrierVersion = 1): Uint8Array {
  if (token.length !== NEARBY_TOKEN_BYTES) throw new Error('bad token');
  if (version !== 1 && version !== 2) throw new Error('bad carrier version');
  return concatBytes(token, version === 2 ? nearbyKeyFingerprintV2(token, publicKey) : nearbyKeyFingerprint(publicKey));
}

export function nearbyKeyFingerprintV2(token: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (token.length !== NEARBY_TOKEN_BYTES || publicKey.length !== 32) throw new Error('bad carrier input');
  return hmacSha256(token, concatBytes(new TextEncoder().encode('zas-nearby-fp-v2'), publicKey)).slice(0, NEARBY_FINGERPRINT_BYTES);
}

/** A phase-1 sender chooses the version from the characteristic it read. */
export function nearbyCarrierMatches(publicKey: Uint8Array, carrier: Uint8Array, version: NearbyCarrierVersion): boolean {
  try {
    const { token } = decodeNearbyCarrier(carrier);
    const expected = encodeNearbyCarrier(token, publicKey, version);
    return expected.every((byte, i) => byte === carrier[i]);
  } catch { return false; }
}

export function decodeNearbyCarrier(carrier: Uint8Array): { token: Uint8Array; fingerprint: Uint8Array } {
  if (carrier.length !== NEARBY_CARRIER_BYTES) throw new Error('bad carrier');
  return {
    token: carrier.slice(0, NEARBY_TOKEN_BYTES),
    fingerprint: carrier.slice(NEARBY_TOKEN_BYTES),
  };
}

/** True only when the resolved key is the one the touch carried. Constant
 *  time is not needed here (both values are public), equality is. */
export function nearbyKeyMatches(publicKey: Uint8Array, fingerprint: Uint8Array): boolean {
  if (fingerprint.length !== NEARBY_FINGERPRINT_BYTES || publicKey.length !== 32) return false;
  const expected = nearbyKeyFingerprint(publicKey);
  return expected.every((byte, i) => byte === fingerprint[i]);
}

// ---- QR: the deep link ---------------------------------------------------

export const NEARBY_ORIGIN = 'https://zas.red';

/** `https://zas.red[/pt|/en]/n/<code_id>#<b64url(channel key)>`. The key
 *  rides in the fragment, which a browser never sends to a server. */
export function nearbyCodeUrl(codeId: string, channelKey: Uint8Array, options: { origin?: string; localePrefix?: '' | '/pt' | '/en' } = {}): string {
  if (!NEARBY_CODE_ID_RE.test(codeId)) throw new Error('bad code id');
  if (channelKey.length !== 32) throw new Error('bad channel key');
  return `${options.origin ?? NEARBY_ORIGIN}${options.localePrefix ?? ''}/n/${codeId}#${toB64Url(channelKey)}`;
}

/** The code id from a path, with or without a locale prefix. */
export function nearbyCodeIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^(?:\/(?:pt|en))?\/n\/([A-Za-z0-9_-]{22})\/?$/);
  return m ? m[1] : null;
}

/** The 32-byte channel key from a fragment (with or without its `#`). */
export function nearbyKeyFromFragment(fragment: string): Uint8Array | null {
  const raw = fragment.replace(/^#/, '').trim();
  if (!raw) return null;
  try {
    const key = fromB64Url(raw);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** Both halves of a scanned or opened code link, or null for anything else. */
export function parseNearbyCodeUrl(url: string): { codeId: string; channelKey: Uint8Array } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  const codeId = nearbyCodeIdFromPath(parsed.pathname);
  const channelKey = nearbyKeyFromFragment(parsed.hash);
  return codeId && channelKey ? { codeId, channelKey } : null;
}

// ---- channel accounting --------------------------------------------------

export interface CountableChannel {
  is_default?: boolean;
  organization_managed?: boolean;
  enterprise_org_id?: string;
  kind?: string;
}

/** Whether a channel this account owns counts toward its channel limit. The
 *  default channel never does, an organization-managed one belongs to the
 *  organization, and a nearby channel is exempt (#35): meeting someone must
 *  not use up a slot. The server and every client count with this. */
export function countsTowardChannelLimit(channel: CountableChannel): boolean {
  return channel.is_default !== true && channel.organization_managed !== true && channel.kind !== 'nearby';
}

/** Owned channels that count, for the personal limit (no organization) or
 *  for one organization's per-member limit. */
export function countedChannels(channels: readonly CountableChannel[], organizationId?: string | null): number {
  return channels.filter((channel) => countsTowardChannelLimit(channel) && (
    organizationId ? channel.enterprise_org_id === organizationId : typeof channel.enterprise_org_id !== 'string'
  )).length;
}

// ---- the sealed item preview (#37) ---------------------------------------
//
// Before Accept or Allow the receiver is not a member and cannot read the
// item, so the sender seals a small preview under the channel key and the
// server passes it through unread. On the /n/ page the fragment key opens it;
// on a touch the receiver opens it with the key it is about to accept.

export interface NearbyPreviewItem {
  name: string;
  /** The manifest's `kind`: 'file' or 'text'. */
  kind: string;
  size: number;
}

/** At most this many items travel in a preview. */
export const NEARBY_PREVIEW_MAX_ITEMS = 3;
/** A name is cut to this many characters. */
export const NEARBY_PREVIEW_NAME_MAX = 80;
/** The server refuses a longer `preview_enc` with 400 bad_request. */
export const NEARBY_PREVIEW_ENC_MAX = 2048;

/** The preview line for one item. A note shows its title, or its first line;
 *  a note its sender marked sensitive shows only its title, because its first
 *  line may be the credential the cover hides. */
export function nearbyPreviewItemOf(manifest: Pick<Manifest, 'kind' | 'name' | 'title' | 'text' | 'size' | 'sensitive'>): NearbyPreviewItem {
  const title = manifest.title?.trim() ?? '';
  let name: string;
  if (manifest.kind === 'text') {
    const firstLine = manifest.sensitive === true ? '' : (manifest.text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
    name = title || firstLine;
  } else {
    name = title || manifest.name;
  }
  return { name: Array.from(name).slice(0, NEARBY_PREVIEW_NAME_MAX).join(''), kind: manifest.kind, size: manifest.size };
}

/** `sealRaw(channelKey, keyVersion, UTF-8 JSON {items})`, in standard base64,
 *  the same envelope the manifests use. */
export function sealNearbyPreview(channelKey: Uint8Array, keyVersion: number, items: readonly NearbyPreviewItem[]): string {
  const plain = {
    items: items.slice(0, NEARBY_PREVIEW_MAX_ITEMS).map((item) => ({
      name: Array.from(item.name).slice(0, NEARBY_PREVIEW_NAME_MAX).join(''),
      kind: item.kind,
      size: item.size,
    })),
  };
  return bytesToB64(sealRaw(channelKey, keyVersion, new TextEncoder().encode(JSON.stringify(plain))));
}

/** The items of a sealed preview, or null when it is missing, does not open,
 *  or does not parse. A client then shows the item count, as before. */
export function openNearbyPreview(channelKey: Uint8Array, previewEnc: unknown): NearbyPreviewItem[] | null {
  if (typeof previewEnc !== 'string' || !previewEnc || previewEnc.length > NEARBY_PREVIEW_ENC_MAX) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(openRaw(channelKey, b64ToBytes(previewEnc)))) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;
    const items = parsed.items
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .slice(0, NEARBY_PREVIEW_MAX_ITEMS)
      .map((item) => ({
        name: typeof item.name === 'string' ? Array.from(item.name).slice(0, NEARBY_PREVIEW_NAME_MAX).join('') : '',
        kind: typeof item.kind === 'string' ? item.kind : 'file',
        size: typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0 ? item.size : 0,
      }));
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}
