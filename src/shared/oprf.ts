// RFC 9497 OPRF, mode 0x00 (base), ciphersuite ristretto255-SHA512.
// The server never learns the input h; the client never learns the server key k.

import { RistrettoPoint } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import { invert, mod } from '@noble/curves/abstract/modular';
import { concatBytes } from './hash.js';
import { OPRF_CONTEXT } from './constants.js';

const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n; // ristretto255 group order
const te = new TextEncoder();

function i2osp(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = value & 0xff;
    value >>>= 8;
  }
  return out;
}

// RFC 9380 expand_message_xmd with SHA-512
export function expandMessageXmd(msg: Uint8Array, dst: Uint8Array, lenInBytes: number): Uint8Array {
  const bInBytes = 64;
  const rInBytes = 128;
  const ell = Math.ceil(lenInBytes / bInBytes);
  if (ell > 255) throw new Error('expand_message_xmd: ell too large');
  const dstPrime = concatBytes(dst, i2osp(dst.length, 1));
  const zPad = new Uint8Array(rInBytes);
  const lIbStr = i2osp(lenInBytes, 2);
  const msgPrime = concatBytes(zPad, msg, lIbStr, i2osp(0, 1), dstPrime);
  const b0 = sha512(msgPrime);
  const b: Uint8Array[] = [];
  b[0] = sha512(concatBytes(b0, i2osp(1, 1), dstPrime));
  for (let i = 2; i <= ell; i++) {
    const xored = new Uint8Array(bInBytes);
    for (let j = 0; j < bInBytes; j++) xored[j] = b0[j] ^ b[i - 2][j];
    b[i - 1] = sha512(concatBytes(xored, i2osp(i, 1), dstPrime));
  }
  return concatBytes(...b).slice(0, lenInBytes);
}

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const byte of bytes) v = (v << 8n) | BigInt(byte);
  return v;
}

export function hashToGroup(input: Uint8Array): InstanceType<typeof RistrettoPoint> {
  const dst = te.encode('HashToGroup-' + OPRF_CONTEXT);
  const uniform = expandMessageXmd(input, dst, 64);
  return RistrettoPoint.hashToCurve(uniform) as InstanceType<typeof RistrettoPoint>;
}

export function hashToScalar(input: Uint8Array): bigint {
  const dst = te.encode('HashToScalar-' + OPRF_CONTEXT);
  const uniform = expandMessageXmd(input, dst, 64);
  return mod(bytesToBigIntBE(uniform), ORDER);
}

export function randomScalar(): bigint {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  const s = mod(bytesToBigIntBE(bytes), ORDER);
  return s === 0n ? 1n : s;
}

export interface BlindResult {
  blind: bigint;
  blindedElement: Uint8Array; // 32 bytes, serialized ristretto point
}

export function oprfBlind(input: Uint8Array): BlindResult {
  const blind = randomScalar();
  const P = hashToGroup(input);
  return { blind, blindedElement: P.multiply(blind).toRawBytes() };
}

/** Server side: evaluatedElement = k * blindedElement */
export function oprfEvaluate(serverKey: bigint, blindedElement: Uint8Array): Uint8Array {
  const B = RistrettoPoint.fromHex(blindedElement);
  return B.multiply(serverKey).toRawBytes();
}

/** Client side: unblind and hash to the final 64-byte OPRF output */
export function oprfFinalize(input: Uint8Array, blind: bigint, evaluatedElement: Uint8Array): Uint8Array {
  const E = RistrettoPoint.fromHex(evaluatedElement);
  const N = E.multiply(invert(blind, ORDER));
  const unblinded = N.toRawBytes();
  const hashInput = concatBytes(
    i2osp(input.length, 2),
    input,
    i2osp(unblinded.length, 2),
    unblinded,
    te.encode('Finalize'),
  );
  return sha512(hashInput);
}

/** Derive a server key from 32 random seed bytes (stored as the OPRF secret). */
export function serverKeyFromSeed(seed: Uint8Array): bigint {
  return hashToScalar(concatBytes(te.encode('zas-oprf-key-v1'), seed));
}
