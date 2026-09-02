import { describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import { THUMBNAIL_MAX_BYTES } from '../src/shared/constants.js';
import { thumbnailFor } from '../src/thumbnail.js';

async function png(width: number, height: number): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0xff0000ff });
  return new Uint8Array(await image.getBuffer('image/png'));
}

describe('thumbnailFor', () => {
  it('answers a JPEG data URI bounded by the shared limits', async () => {
    const uri = await thumbnailFor(await png(1200, 800), 'image/png');
    expect(uri).toBeDefined();
    expect(uri!.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(uri!.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    const decoded = await Jimp.read(Buffer.from(uri!.slice('data:image/jpeg;base64,'.length), 'base64'));
    expect(decoded.width).toBe(640);
  });

  it('leaves an image that already fits alone', async () => {
    const uri = await thumbnailFor(await png(200, 100), 'image/png');
    const decoded = await Jimp.read(Buffer.from(uri!.slice('data:image/jpeg;base64,'.length), 'base64'));
    expect(decoded.width).toBe(200);
    expect(decoded.height).toBe(100);
  });

  it('says nothing for a type it does not read', async () => {
    expect(await thumbnailFor(new TextEncoder().encode('hola'), 'text/plain')).toBeUndefined();
    expect(await thumbnailFor(await png(20, 20), 'application/pdf')).toBeUndefined();
  });

  it('says nothing when the bytes are not the image they claim to be', async () => {
    expect(await thumbnailFor(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'image/png')).toBeUndefined();
  });

  it('refuses to decode an image over the browser input cap', async () => {
    // Never written anywhere: the cap is read off `bytes.length`, so the
    // allocation alone is the whole fixture. One byte over 80 MiB. The spy is
    // the assertion that matters — a decode that is merely caught still built
    // the bitmap first, and an out-of-memory abort is not catchable.
    const read = vi.spyOn(Jimp, 'read');
    try {
      const huge = new Uint8Array(80 * 1024 * 1024 + 1);
      expect(await thumbnailFor(huge, 'image/png')).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});
