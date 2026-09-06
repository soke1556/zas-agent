// The bytes a Directo send reads from. Node's `openAsBlob` is convenient - one
// call gives a Blob the engine can slice - but its `size` is truncated to 32
// bits for a file of 4 GiB or more, and its own `slice()` clamps to that wrong
// size, so it can neither report nor read the whole file. A 9 GiB file offered
// its size mod 2^32 (1 GiB) and delivered only the first gigabyte, and both
// ends agreed it was whole. The correction: trust the on-disk size and read
// true 64-bit offsets, applied only when the blob under-reports (every file
// under 4 GiB is left exactly as it was).
import { promises as fsp, statSync } from 'node:fs';

/** Read `length` bytes from `path` starting at `start`. `position` is a plain
 *  number, safe past 2^53, so this reaches the far end of a file `openAsBlob`
 *  cannot. Returns fewer bytes at end of file. One open/read/close per window;
 *  a window is a few MiB, so a 9 GiB file is a couple of thousand reads,
 *  nothing against the bytes that then cross the network. */
export async function readFileRange(path: string, start: number, length: number): Promise<ArrayBuffer> {
  const fh = await fsp.open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.max(0, length));
    let read = 0;
    while (read < length) {
      const { bytesRead } = await fh.read(buf, read, length - read, start + read);
      if (bytesRead === 0) break; // end of file
      read += bytesRead;
    }
    const out = new Uint8Array(read);
    out.set(buf.subarray(0, read));
    return out.buffer;
  } finally {
    await fh.close();
  }
}

interface DirectFilePart {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The narrow surface the sender reads off a file: `directMetaOf` takes `size`
 *  and `type` (and an absent `name`), and the pump loops on `size` and reads
 *  `slice(start, end).arrayBuffer()`. Enough of a Blob for that, and no more. */
interface DirectFile {
  readonly size: number;
  readonly type: string;
  slice(start: number, end: number): DirectFilePart;
}

/** Return a file the sender can trust. When the on-disk size is larger than the
 *  blob reports - the `openAsBlob` 32-bit truncation, and the only time the two
 *  disagree - stand in a source that reports the real size and reads the real
 *  bytes by offset. Otherwise hand back the blob unchanged, so every transfer
 *  that already worked reads exactly as before. If the path cannot be stat-ed
 *  (a fake path in a test, a file that moved), the blob is all there is. */
export function directFileFrom(path: string, raw: Blob): Blob {
  let statSize: number;
  try {
    statSize = statSync(path).size;
  } catch {
    return raw;
  }
  if (statSize <= raw.size) return raw;
  const type = raw.type;
  const file: DirectFile = {
    size: statSize,
    type,
    slice(start: number, end: number): DirectFilePart {
      const from = Math.max(0, Math.min(start, statSize));
      const to = Math.max(from, Math.min(end, statSize));
      return { arrayBuffer: () => readFileRange(path, from, to - from) };
    },
  };
  return file as unknown as Blob;
}
