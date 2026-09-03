// Agents: a coding agent on the owner's machine that sends into the owner's
// channels as a delegated principal. Everything both sides must agree on
// byte-for-byte lives here: the uid shape, the challenge bytes, the sizes.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes } from './hash.js';
import type { AgentLimits } from './constants.js';

export const AGENT_UID_RE = /^agent_[A-Za-z0-9_-]{22}$/;
export function isAgentUid(uid: string): boolean {
  return AGENT_UID_RE.test(uid);
}

export const AGENT_KINDS = ['claude_code', 'codex', 'other'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

export const AGENT_LIMIT_PER_ACCOUNT = 10;
export const AGENT_PAIRING_TTL_MS = 10 * 60 * 1000;
export const AGENT_CHALLENGE_TTL_MS = 60 * 1000;
export const AGENT_TOKEN_TTL_SEC = 3600;
export const AGENT_LAST_SEEN_BUCKET_MS = 5 * 60 * 1000;
export const AGENT_NAME_MAX = 60;
export const AGENT_HOST_MAX = 60;
/** MAGIC(3) + keyVersion(1) + ephemeral X25519 public(32) + nonce(24) + sealed key(32 + 16). */
export const AGENT_GRANT_ENVELOPE_BYTES = 108;

export const AGENT_CHALLENGE_DOMAIN = 'ZAS-AGENT-CHALLENGE-V1';

/** No 0/O, no 1/I/L: a person reads this code off one screen and types it
 *  into another, so the alphabet is the one where that cannot go wrong. The
 *  server mints from it, the page shows it, the CLI takes a typed one. */
export const AGENT_PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const AGENT_PAIRING_CODE_LENGTH = 8;
/** What a CLI that claims its own pairing announces at creation. */
export const AGENT_PAIRING_PROTOCOL = 2;
/** How long an approved protocol-2 pairing waits for its claim. */
export const AGENT_CLAIM_TTL_MS = 5 * 60 * 1000;
/** Wrong claim codes before the pairing is cancelled. */
export const AGENT_CLAIM_ATTEMPTS = 5;

/** Upper case, alphabet characters only, no length rule: what a field shows
 *  while the person is still typing. A character outside the alphabet is not
 *  corrected to a lookalike, it is dropped. */
export function keepPairingCodeChars(raw: string): string {
  return raw.toUpperCase().split('').filter((c) => AGENT_PAIRING_CODE_ALPHABET.includes(c)).join('');
}

/** Whatever was typed becomes the code, or nothing at all. Spaces, the display
 *  hyphen and case are noise; the length check refuses the whole entry rather
 *  than guessing at a different code. */
export function normalizePairingCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const kept = keepPairingCodeChars(raw);
  return kept.length === AGENT_PAIRING_CODE_LENGTH ? kept : '';
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const text = new TextEncoder();

function field(bytes: Uint8Array): Uint8Array {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  return concatBytes(length, bytes);
}

/** sha256 over four length-prefixed fields. Length prefixes, not separators:
 *  a uid or challenge id could otherwise be split at a different byte. */
export function agentChallengeBytes(agentUid: string, challengeId: string, nonce: Uint8Array): Uint8Array {
  return sha256(concatBytes(
    field(text.encode(AGENT_CHALLENGE_DOMAIN)),
    field(text.encode(agentUid)),
    field(text.encode(challengeId)),
    field(nonce),
  ));
}

export function signAgentChallenge(privateKey: Uint8Array, agentUid: string, challengeId: string, nonce: Uint8Array): Uint8Array {
  return p256.sign(agentChallengeBytes(agentUid, challengeId, nonce), privateKey, { lowS: true }).toCompactRawBytes();
}

export function verifyAgentChallenge(
  publicKey: Uint8Array,
  signature: Uint8Array,
  agentUid: string,
  challengeId: string,
  nonce: Uint8Array,
): boolean {
  try {
    return signature.length === 64 && publicKey.length === 65
      && p256.verify(signature, agentChallengeBytes(agentUid, challengeId, nonce), publicKey, { lowS: true });
  } catch {
    return false;
  }
}

export function agentFingerprint(p256Public: Uint8Array): string {
  return bytesToHex(sha256(p256Public));
}

/** The first 16 hex characters in groups of four: what the pairing page and
 *  the terminal both show, so a human can compare them at a glance. */
export function agentFingerprintShort(fingerprint: string): string {
  return fingerprint.slice(0, 16).match(/.{4}/g)!.join(' ');
}

/** Same content into the same channel under the same title is the same item.
 *  32 hex characters so it passes the API's id check. */
export function agentSendIdempotencyKey(channelId: string, contentHashHex: string, title: string): string {
  return bytesToHex(sha256(text.encode(`${channelId}\0${contentHashHex}\0${title}`))).slice(0, 32);
}

export const AGENT_ERRORS = [
  'agent_forbidden', 'agent_revoked', 'grant_missing', 'send_forbidden', 'read_forbidden',
  'direct_mode', 'not_direct_mode',
  'key_stale', 'quota_exceeded', 'rate_limited', 'file_too_big', 'duplicate', 'pairing_expired',
  'pairing_cancelled', 'feature_disabled',
  // The claim step: a wrong code, a claim before the owner approved, a claim
  // of a pairing already claimed.
  'claim_mismatch', 'pairing_not_approved', 'pairing_claimed',
] as const;
export type AgentError = (typeof AGENT_ERRORS)[number];

/** Where an account's agent numbers came from: its plan row, or the smallest
 *  `maxAgentsPerMember` among the organizations it belongs to as a member or
 *  guest. */
export const AGENT_LIMIT_SOURCES = ['plan', 'enterprise'] as const;
export type AgentLimitSource = (typeof AGENT_LIMIT_SOURCES)[number];
export interface ResolvedAgentLimits extends AgentLimits {
  source: AgentLimitSource;
}

/** Every refusal the owner routes can answer. `agent_limit` and `grant_limit`
 *  arrive as 409 with the number that was full in `limit`. */
export const AGENT_OWNER_ERRORS = [
  'pairing_missing', 'pairing_cancelled', 'pairing_expired', 'code_mismatch',
  'agent_limit', 'grant_limit', 'unknown_channel', 'unknown_agent',
  // A protocol-2 pairing approved once: the claim code is not minted twice.
  'pairing_approved',
] as const;
export type AgentOwnerError = (typeof AGENT_OWNER_ERRORS)[number];

export const AGENT_ACTIVITY_KINDS = ['paired', 'send', 'direct_sent', 'direct_received', 'direct_failed', 'grant_changed', 'revoked'] as const;
export type AgentActivityKind = (typeof AGENT_ACTIVITY_KINDS)[number];

/** One channel grant as the owner's browser writes it and the agent reads it. */
export interface AgentGrant {
  channel_id: string;
  send: boolean;
  read: boolean;
  /** `assignChannelKey(agentX25519Public, 1, channelKey)`, base64. */
  wrapped_key: string;
  /** The owner's account-key generation to seal manifests with. */
  key_version: number;
  /** `encryptChannelName(channelKey, name, key_version)`, base64. */
  name_enc: string;
}
