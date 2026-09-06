// The file source a Directo send reads from. Node's `openAsBlob` truncates
// Blob.size to 32 bits for a file >= 4 GiB, and its own slice() clamps to that
// wrong size, so it can neither report nor read the whole file. These tests
// pin the correction: trust the on-disk size and read true 64-bit offsets,
// and leave an already-accurate blob untouched.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directFileFrom, readFileRange } from '../src/file-source.js';

// byte i = i mod 251 (prime, so every window is distinctive)
const pattern = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
};

describe('file-source', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zas-file-source-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('readFileRange returns the exact interior bytes at an offset', async () => {
    const p = join(dir, 'data.bin');
    const all = pattern(100_000);
    writeFileSync(p, all);
    const buf = new Uint8Array(await readFileRange(p, 40_000, 4_096));
    expect(buf.length).toBe(4_096);
    expect(buf).toEqual(all.subarray(40_000, 44_096));
  });

  it('readFileRange clamps a range that runs past the end of the file', async () => {
    const p = join(dir, 'short.bin');
    const all = pattern(1_000);
    writeFileSync(p, all);
    const buf = new Uint8Array(await readFileRange(p, 900, 4_096));
    expect(buf.length).toBe(100);
    expect(buf).toEqual(all.subarray(900, 1_000));
  });

  it('directFileFrom trusts the on-disk size when the blob under-reports', async () => {
    const p = join(dir, 'big.bin');
    const all = pattern(100_000);
    writeFileSync(p, all);
    // openAsBlob for a >= 4 GiB file reports size mod 2^32 and its slice clamps
    // to that; a blob that lies low stands in for it. The fix must ignore it.
    const raw = new Blob([all.subarray(0, 40_000)], { type: 'application/octet-stream' });
    const file = directFileFrom(p, raw);
    expect(file.size).toBe(100_000);
    const whole = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
    expect(whole.length).toBe(100_000);
    expect(whole).toEqual(all);
    // a window in the far half reads real bytes, not the blob's short content
    const win = new Uint8Array(await file.slice(60_000, 64_096).arrayBuffer());
    expect(win).toEqual(all.subarray(60_000, 64_096));
  });

  it('directFileFrom returns an accurate blob unchanged', async () => {
    const p = join(dir, 'exact.bin');
    const all = pattern(2_048);
    writeFileSync(p, all);
    const raw = new Blob([all], { type: 'text/plain' });
    const file = directFileFrom(p, raw);
    expect(file.size).toBe(2_048);
    expect(file.type).toBe('text/plain');
    const mid = new Uint8Array(await file.slice(100, 200).arrayBuffer());
    expect(mid).toEqual(all.subarray(100, 200));
  });

  it('directFileFrom falls back to the blob when the path cannot be stat-ed', () => {
    const raw = new Blob([new Uint8Array(5)]);
    const file = directFileFrom('/no/such/path-zzz.bin', raw);
    expect(file.size).toBe(5);
  });
});
