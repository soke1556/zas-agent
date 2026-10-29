// Keep one descriptor through hashing and upload. Reopening the path for each
// pass could combine the identity of one file with the bytes of another.
import { constants, promises as fsp, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { createBLAKE3 } from 'hash-wasm';
import { ZasError } from './errors.js';
import { MAX_THUMBNAIL_INPUT_BYTES, thumbnailable, thumbnailFor } from './thumbnail.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const READ_BYTES = 1024 * 1024;

function validFile(stat: Stats): void {
  if (!stat.isFile()) throw new ZasError('upload_failed', 400);
  if (stat.size > MAX_FILE_BYTES) throw new ZasError('file_too_big', 413);
}

export async function checkFilePath(path: string): Promise<void> {
  const stat = await fsp.stat(path).catch(() => { throw new ZasError('upload_failed', 400); });
  validFile(stat);
}

export class UploadSource {
  readonly name: string;
  readonly size: number;
  private digest?: string;

  private constructor(private handle: FileHandle, private initial: Stats, path: string) {
    this.name = basename(path);
    this.size = initial.size;
  }

  static async open(path: string): Promise<UploadSource> {
    await checkFilePath(path);
    // If a regular file is replaced by a FIFO between stat and open, do not
    // wait for a writer. fstat below still refuses every non-regular file.
    const handle = await fsp.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
      .catch(() => { throw new ZasError('upload_failed', 400); });
    try {
      const stat = await handle.stat();
      validFile(stat);
      return new UploadSource(handle, stat, path);
    } catch (error) { await handle.close(); throw error; }
  }

  async unchanged(): Promise<void> {
    const now = await this.handle.stat().catch(() => { throw new ZasError('upload_failed', 400); });
    if (now.size !== this.size || now.mtimeMs !== this.initial.mtimeMs || now.ctimeMs !== this.initial.ctimeMs) {
      throw new ZasError('file_changed', 409);
    }
  }

  async *bytes(): AsyncGenerator<Uint8Array> {
    await this.unchanged();
    const hash = await createBLAKE3();
    for (let position = 0; position < this.size;) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, this.size - position));
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, position)
        .catch(() => { throw new ZasError('upload_failed', 400); });
      if (bytesRead === 0) throw new ZasError('file_changed', 409);
      const bytes = buffer.subarray(0, bytesRead);
      position += bytesRead;
      hash.update(bytes);
      yield bytes;
    }
    await this.unchanged();
    const digest = hash.digest('hex');
    // Metadata checks catch ordinary edits; comparing the actual bytes also
    // protects the idempotency key when timestamps are restored by a writer.
    if (this.digest !== undefined && digest !== this.digest) throw new ZasError('file_changed', 409);
    this.digest = digest;
  }

  async contentHash(): Promise<string> {
    for await (const _ of this.bytes()) { /* hash without retaining plaintext */ }
    return this.digest!;
  }

  async thumbnail(mime: string): Promise<string | undefined> {
    if (!thumbnailable(mime) || this.size > MAX_THUMBNAIL_INPUT_BYTES) return undefined;
    const buffer = Buffer.allocUnsafe(this.size);
    let offset = 0;
    for await (const bytes of this.bytes()) { buffer.set(bytes, offset); offset += bytes.length; }
    return thumbnailFor(buffer, mime);
  }

  close(): Promise<void> { return this.handle.close(); }
}
