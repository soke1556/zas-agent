// FastCDC content-defined chunking, pinned as chunker_v1.
// 32-bit gear hash; gear table derived deterministically from BLAKE3(GEAR_SEED + index).
// Parameters and table are frozen: any change breaks cross-version dedup.

import { blake3 } from 'hash-wasm';
import { CHUNK_MIN, CHUNK_MAX, CHUNK_AVG_BITS, GEAR_SEED } from './constants.js';

let gearPromise: Promise<Uint32Array> | null = null;

export function gearTable(): Promise<Uint32Array> {
  if (!gearPromise) {
    gearPromise = (async () => {
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        const hex = await blake3(new TextEncoder().encode(GEAR_SEED + i), 256);
        table[i] = parseInt(hex.slice(0, 8), 16) >>> 0;
      }
      return table;
    })();
  }
  return gearPromise;
}

const AVG = 1 << CHUNK_AVG_BITS;
// Normalized chunking: stricter mask before the average point, looser after.
const MASK_S = (1 << (CHUNK_AVG_BITS + 2)) - 1;
const MASK_L = (1 << (CHUNK_AVG_BITS - 2)) - 1;

/** Find the next cut point in buf (which starts at a chunk boundary). Returns length <= buf.length. */
export function cutPoint(buf: Uint8Array, gear: Uint32Array, eof: boolean): number | null {
  const len = Math.min(buf.length, CHUNK_MAX);
  if (buf.length < CHUNK_MAX && !eof) {
    // Not enough data to guarantee a decision unless we find a cut before buf end.
    if (buf.length <= CHUNK_MIN) return null;
  }
  if (eof && len <= CHUNK_MIN) return len > 0 ? len : null;
  let hash = 0;
  const normal = Math.min(AVG, len);
  let i = CHUNK_MIN;
  for (; i < normal; i++) {
    hash = (((hash << 1) >>> 0) + gear[buf[i]]) >>> 0;
    if ((hash & MASK_S) === 0) return i + 1;
  }
  for (; i < len; i++) {
    hash = (((hash << 1) >>> 0) + gear[buf[i]]) >>> 0;
    if ((hash & MASK_L) === 0) return i + 1;
  }
  if (len === CHUNK_MAX) return CHUNK_MAX;
  if (eof) return len > 0 ? len : null;
  return null;
}

/** Chunk an async iterable of byte arrays into content-defined chunks. */
export async function* chunkStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const gear = await gearTable();
  let pending: Uint8Array[] = [];
  let pendingLen = 0;

  const compact = (): Uint8Array => {
    if (pending.length === 1) return pending[0];
    const merged = new Uint8Array(pendingLen);
    let off = 0;
    for (const p of pending) {
      merged.set(p, off);
      off += p.length;
    }
    pending = [merged];
    return merged;
  };

  const drain = function* (eof: boolean): Generator<Uint8Array> {
    while (pendingLen > 0) {
      const buf = compact();
      const cut = cutPoint(buf, gear, eof);
      if (cut === null) return;
      yield buf.slice(0, cut);
      pending = cut < buf.length ? [buf.slice(cut)] : [];
      pendingLen = buf.length - cut;
    }
  };

  for await (const piece of source as AsyncIterable<Uint8Array>) {
    if (piece.length === 0) continue;
    pending.push(piece);
    pendingLen += piece.length;
    if (pendingLen >= CHUNK_MAX) yield* drain(false);
  }
  yield* drain(true);
}
