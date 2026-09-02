// A shared channel's key is random — not derived from anyone's master key —
// so every member, owner included, holds it the same way: sealed under their
// own account key, generation named in the envelope.
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { concatBytes, hkdf512 } from './hash.js';
import { sealRaw, openRaw, envelopeVersion } from './manifest.js';

const ASSIGNMENT_MAGIC = new Uint8Array([0x5a, 0x43, 0x01]); // "ZC", v1
const ASSIGNMENT_HEADER_BYTES = 3 + 1 + 32 + 24;

function assignmentPrivateKey(accountKey: Uint8Array): Uint8Array {
  return hkdf512(accountKey, 'ZAS-CHANNEL-ASSIGNMENT-X25519-V1', 32);
}

/** Public key an account may publish for admin-managed channel assignment.
 * It is generation-specific and cannot be used to recover the account key. */
export function channelAssignmentPublicKey(accountKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(assignmentPrivateKey(accountKey));
}

function assignmentEnvelope(envelope: Uint8Array): boolean {
  return envelope.length >= ASSIGNMENT_HEADER_BYTES + 16 &&
    envelope[0] === ASSIGNMENT_MAGIC[0] && envelope[1] === ASSIGNMENT_MAGIC[1] && envelope[2] === ASSIGNMENT_MAGIC[2];
}

/** Account-key generation needed to open either the original self-wrapped
 * envelope or a public-key assignment envelope. */
export function channelWrappedKeyVersion(envelope: Uint8Array): number {
  return assignmentEnvelope(envelope) ? envelope[3] : envelopeVersion(envelope);
}

/** Seals a channel key for a member without revealing it to the server. */
export function assignChannelKey(publicKey: Uint8Array, keyVersion: number, channelKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32 || channelKey.length !== 32 || keyVersion < 1 || keyVersion > 255) throw new Error('bad channel assignment');
  const ephemeralPrivate = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  const shared = x25519.getSharedSecret(ephemeralPrivate, publicKey);
  const key = hkdf512(shared, 'ZAS-CHANNEL-ASSIGNMENT-ENVELOPE-V1', 32);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(channelKey);
  ephemeralPrivate.fill(0); shared.fill(0); key.fill(0);
  return concatBytes(ASSIGNMENT_MAGIC, new Uint8Array([keyVersion]), ephemeralPublic, nonce, ciphertext);
}

/** Opens an assignment envelope with the recipient's raw X25519 private key.
 *  Members derive theirs from the account key; an agent holds its own. */
export function openChannelAssignment(privateKey: Uint8Array, envelope: Uint8Array): Uint8Array {
  if (!assignmentEnvelope(envelope)) throw new Error('bad envelope');
  const ephemeralPublic = envelope.slice(4, 36);
  const nonce = envelope.slice(36, 60);
  const shared = x25519.getSharedSecret(privateKey, ephemeralPublic);
  const key = hkdf512(shared, 'ZAS-CHANNEL-ASSIGNMENT-ENVELOPE-V1', 32);
  const plain = xchacha20poly1305(key, nonce).decrypt(envelope.slice(60));
  shared.fill(0); key.fill(0);
  if (plain.length !== 32) throw new Error('bad channel key');
  return plain;
}

function openAssignedChannelKey(accountKey: Uint8Array, envelope: Uint8Array): Uint8Array {
  const priv = assignmentPrivateKey(accountKey);
  try { return openChannelAssignment(priv, envelope); } finally { priv.fill(0); }
}

export function mintChannelKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

export function wrapChannelKey(accountKey: Uint8Array, version: number, channelKey: Uint8Array): Uint8Array {
  return sealRaw(accountKey, version, channelKey);
}

export function unwrapChannelKey(accountKey: Uint8Array, wrapped: Uint8Array): Uint8Array {
  const key = assignmentEnvelope(wrapped) ? openAssignedChannelKey(accountKey, wrapped) : openRaw(accountKey, wrapped);
  if (key.length !== 32) throw new Error('bad channel key');
  return key;
}
