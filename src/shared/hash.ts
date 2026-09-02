import { blake3 } from 'hash-wasm';
import { hkdf } from '@noble/hashes/hkdf';
import { sha512 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

export async function blake3Bytes(data: Uint8Array): Promise<Uint8Array> {
  const hex = await blake3(data, 256);
  return hexToBytes(hex);
}

export async function blake3Hex(data: Uint8Array): Promise<string> {
  return blake3(data, 256);
}

export function hkdf512(ikm: Uint8Array, info: string, length: number): Uint8Array {
  return hkdf(sha512, ikm, undefined, new TextEncoder().encode(info), length);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64;
}

export function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== 'undefined') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
