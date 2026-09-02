// Agents: a coding agent on the owner's machine that sends into the owner's
// channels as a delegated principal. Everything both sides must agree on
// byte-for-byte lives here: the uid shape, the challenge bytes, the sizes.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes } from './hash.js';

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
] as const;
export type AgentError = (typeof AGENT_ERRORS)[number];

export const AGENT_ACTIVITY_KINDS = ['paired', 'send', 'direct_sent', 'direct_failed', 'grant_changed', 'revoked'] as const;
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
