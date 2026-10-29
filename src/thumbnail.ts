// Previews ride inside the sealed, per-link manifest. A failed or unavailable
// decoder must never prevent a file transfer.
import { THUMBNAIL_MAX_BYTES, THUMBNAIL_MAX_EDGE } from './shared/constants.js';

const PREFIX = 'data:image/jpeg;base64,';
const READABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff']);
const QUALITY_STEPS = [85, 70, 55, 40];
export const MAX_THUMBNAIL_INPUT_BYTES = 80 * 1024 * 1024;
// A compressed image's byte length does not bound the decoded allocation.
export const MAX_THUMBNAIL_PIXELS = 16_000_000;

export function thumbnailable(mime: string): boolean {
  return READABLE.has(mime.split(';')[0].trim().toLowerCase());
}

export async function thumbnailFor(bytes: Uint8Array, mime: string): Promise<string | undefined> {
  if (!thumbnailable(mime) || bytes.length > MAX_THUMBNAIL_INPUT_BYTES) return undefined;
  try {
    const { default: sharp } = await import('sharp');
    const image = sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      limitInputPixels: MAX_THUMBNAIL_PIXELS,
    }).autoOrient().resize({
      width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE,
      fit: 'inside', withoutEnlargement: true,
    });
    for (const quality of QUALITY_STEPS) {
      const jpeg = await image.clone().jpeg({ quality }).toBuffer();
      const uri = PREFIX + jpeg.toString('base64');
      if (uri.length <= THUMBNAIL_MAX_BYTES) return uri;
    }
  } catch {
    // Unsupported platform/codec, malformed bytes, or an oversized bitmap.
  }
  return undefined;
}
