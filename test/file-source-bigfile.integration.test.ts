// A real >= 4 GiB file read end to end through the shipped Directo file source,
// the proof that the openAsBlob 32-bit truncation is gone and reads past the
// 4 GiB offset are correct. It runs only where the file exists (set
// ZAS_BIGFILE + ZAS_BIGFILE_SHA256), so CI, which has neither, skips it.
//
// It reads the file the exact way the engine sender does - `directFileFrom`
// wrapping `openAsBlob`, then `slice(off, off + window).arrayBuffer()` in
// DIRECT_RECEIVE_WINDOW_BYTES windows - and hashes every byte. A match means
// the fd-backed source reported the true size and read all 64-bit offsets.
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIRECT_RECEIVE_WINDOW_BYTES } from '../src/shared/direct.js';
import { directFileFrom } from '../src/file-source.js';

const BIG = process.env.ZAS_BIGFILE ?? 'E:/zas-directo-test/f-9g.bin';
const EXPECT = (process.env.ZAS_BIGFILE_SHA256
  ?? 'afcda9b16ec0c24aadee5501ca581c0656a95e752cfd6cb27a187415a50914b5').toLowerCase();

const runIf = existsSync(BIG) ? it : it.skip;

describe('file-source big file', () => {
  runIf('reads the whole >= 4 GiB file through directFileFrom and the hash matches', async () => {
    const statSize = statSync(BIG).size;
    const raw = await openAsBlob(BIG, { type: 'application/octet-stream' });
    // The bug this guards against: openAsBlob under-reports a >= 4 GiB file.
    expect(statSize).toBeGreaterThanOrEqual(4 * 1024 ** 3);
    expect(raw.size).toBeLessThan(statSize);

    const file = directFileFrom(BIG, raw);
    expect(file.size).toBe(statSize);

    const hasher = createHash('sha256');
    let read = 0;
    for (let off = 0; off < file.size; off += DIRECT_RECEIVE_WINDOW_BYTES) {
      const end = Math.min(off + DIRECT_RECEIVE_WINDOW_BYTES, file.size);
      const win = new Uint8Array(await file.slice(off, end).arrayBuffer());
      hasher.update(win);
      read += win.length;
    }
    expect(read).toBe(statSize);
    expect(hasher.digest('hex')).toBe(EXPECT);
  }, 300_000);
});
