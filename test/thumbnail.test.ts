import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { THUMBNAIL_MAX_BYTES } from '../src/shared/constants.js';
import { MAX_THUMBNAIL_INPUT_BYTES, thumbnailFor } from '../src/thumbnail.js';

async function png(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 4, background: '#ff0000' } }).png().toBuffer();
}

describe('thumbnailFor', () => {
  it('answers a JPEG data URI bounded by the shared limits', async () => {
    const uri = await thumbnailFor(await png(1200, 800), 'image/png');
    expect(uri).toBeDefined();
    expect(uri!.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(uri!.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    const decoded = await sharp(Buffer.from(uri!.split(',')[1], 'base64')).metadata();
    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(427);
  });

  it('does not enlarge an image that already fits', async () => {
    const uri = await thumbnailFor(await png(200, 100), 'image/png');
    const decoded = await sharp(Buffer.from(uri!.split(',')[1], 'base64')).metadata();
    expect(decoded.width).toBe(200);
    expect(decoded.height).toBe(100);
  });

  it('skips unsupported types and corrupt images', async () => {
    expect(await thumbnailFor(new TextEncoder().encode('hola'), 'text/plain')).toBeUndefined();
    expect(await thumbnailFor(await png(20, 20), 'application/pdf')).toBeUndefined();
    expect(await thumbnailFor(new Uint8Array([1, 2, 3, 4]), 'image/png')).toBeUndefined();
  });

  it('refuses an image over the compressed input cap', async () => {
    expect(await thumbnailFor(new Uint8Array(MAX_THUMBNAIL_INPUT_BYTES + 1), 'image/png')).toBeUndefined();
  });

  it('refuses a small compressed file whose decoded bitmap exceeds the pixel cap', async () => {
    const compressed = await png(4001, 4000);
    expect(compressed.length).toBeLessThan(1024 * 1024);
    expect(await thumbnailFor(compressed, 'image/png')).toBeUndefined();
  });

  it('previews WebP images', async () => {
    const bytes = await sharp(await png(40, 20)).webp().toBuffer();
    expect(await thumbnailFor(bytes, 'image/webp')).toMatch(/^data:image\/jpeg;base64,/);
  });
});
