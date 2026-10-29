import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UploadSource } from '../src/upload-source.js';
import { blake3Hex } from '../src/shared/hash.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zas-upload-source-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it('hashes and rereads a file in bounded pieces without readFile', async () => {
  const path = join(dir, 'bytes.bin');
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 29);
  writeFileSync(path, bytes);
  const readFile = vi.spyOn(fsp, 'readFile').mockRejectedValue(new Error('whole-file read'));
  const source = await UploadSource.open(path);
  try {
    expect(await source.contentHash()).toBe(await blake3Hex(bytes));
    let offset = 0;
    for await (const piece of source.bytes()) {
      expect(piece.length).toBeLessThanOrEqual(1024 * 1024);
      expect(Buffer.from(piece).equals(bytes.subarray(offset, offset + piece.length))).toBe(true);
      offset += piece.length;
    }
    expect(offset).toBe(bytes.length);
    expect(readFile).not.toHaveBeenCalled();
  } finally { await source.close(); }
});

it.each(['longer content', 'x', 'same'])('refuses changed content before a second pass: %s', async content => {
  const path = join(dir, 'bytes.bin');
  writeFileSync(path, 'test');
  const source = await UploadSource.open(path);
  try {
    await source.contentHash();
    writeFileSync(path, content);
    await expect(source.contentHash()).rejects.toMatchObject({ code: 'file_changed' });
  } finally { await source.close(); }
});

it('refuses truncation during a pass', async () => {
  const path = join(dir, 'bytes.bin');
  writeFileSync(path, Buffer.alloc(2 * 1024 * 1024));
  const source = await UploadSource.open(path);
  try {
    const reader = source.bytes();
    await reader.next();
    writeFileSync(path, 'short');
    await expect(reader.next()).rejects.toMatchObject({ code: 'file_changed' });
  } finally { await source.close(); }
});

it('hashes an empty file consistently', async () => {
  const path = join(dir, 'empty.bin');
  writeFileSync(path, '');
  const source = await UploadSource.open(path);
  try { expect(await source.contentHash()).toBe(await blake3Hex(new Uint8Array())); }
  finally { await source.close(); }
});

it('compares the bytes even if metadata checks cannot observe a same-size rewrite', async () => {
  const path = join(dir, 'changed.bin');
  writeFileSync(path, 'before');
  const source = await UploadSource.open(path);
  try {
    await source.contentHash();
    vi.spyOn(source, 'unchanged').mockResolvedValue();
    writeFileSync(path, 'after!');
    await expect(source.contentHash()).rejects.toMatchObject({ code: 'file_changed' });
  } finally { await source.close(); }
});
