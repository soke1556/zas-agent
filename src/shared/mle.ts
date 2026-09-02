// Message-locked encryption of chunks (spec §5.3).
// Key and nonce are derived deterministically from the OPRF output f:
// identical plaintext -> identical ciphertext -> identical blob_id (global dedup).

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf512, blake3Hex } from './hash.js';
import { HKDF_INFO_CHUNK_KEY, HKDF_INFO_CHUNK_NONCE } from './constants.js';

export interface EncryptedChunk {
  ciphertext: Uint8Array;
  blobId: string; // lowercase hex BLAKE3-256 of ciphertext
  key: Uint8Array; // 32 bytes, stored (b64) in the manifest for decryption
  nonce: Uint8Array; // 24 bytes
}

export function chunkKeyFromF(f: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  return {
    key: hkdf512(f, HKDF_INFO_CHUNK_KEY, 32),
    nonce: hkdf512(f, HKDF_INFO_CHUNK_NONCE, 24),
  };
}

export async function encryptChunk(f: Uint8Array, plaintext: Uint8Array): Promise<EncryptedChunk> {
  const { key, nonce } = chunkKeyFromF(f);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const blobId = await blake3Hex(ciphertext);
  return { ciphertext, blobId, key, nonce };
}

/**
 * Per-item encryption for storage v2. A new random key and nonce prevent the
 * same plaintext in two items from producing a correlatable object id. The
 * manifest shape and decryptor stay compatible with every current client.
 */
export async function encryptRandomChunk(plaintext: Uint8Array): Promise<EncryptedChunk> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const blobId = await blake3Hex(ciphertext);
  return { ciphertext, blobId, key, nonce };
}

export function decryptChunk(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce).decrypt(ciphertext);
}
