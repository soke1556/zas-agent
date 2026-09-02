// A JPEG preview that rides inside the sealed manifest, exactly as the browser
// writes one (web/src/lib/thumbnail.ts). Same bounds, same reason: a separate
// content-addressed thumbnail would be a second, smaller, separately
// claim-counted object derived from the same photo, and the manifest is
// per-link and never deduplicated.
//
// A thumbnail is a nicety. Nothing here is allowed to fail a send: every path
// out of `thumbnailFor` is either a data URI within budget or `undefined`.
import { Jimp } from 'jimp';
import { THUMBNAIL_MAX_BYTES, THUMBNAIL_MAX_EDGE } from './shared/constants.js';

const PREFIX = 'data:image/jpeg;base64,';

/** What jimp decodes without a plugin. Video and PDF have no decoder in a CLI
 *  that must stay installable in seconds, so they get no preview here. */
const READABLE = new Set(['image/jpeg', 'image/png', 'image/bmp', 'image/gif', 'image/tiff']);

/** Down until it fits. A thumbnail that bloats the manifest is worse than none. */
const QUALITY_STEPS = [85, 70, 55, 40];

/** The browser's ceiling (web/src/lib/thumbnail.ts:17), and for its reason: a
 *  decoded bitmap is width x height x 4 bytes, so a file this size can abort
 *  the process on allocation — and an out-of-memory abort is not something the
 *  `catch` below can turn into `undefined`. Refused before the decode, not
 *  during it. */
const MAX_INPUT_BYTES = 80 * 1024 * 1024;

export function thumbnailable(mime: string): boolean {
  return READABLE.has(mime.split(';')[0].trim().toLowerCase());
}

export async function thumbnailFor(bytes: Uint8Array, mime: string): Promise<string | undefined> {
  if (!thumbnailable(mime)) return undefined;
  if (bytes.length > MAX_INPUT_BYTES) return undefined;
  try {
    // jimp reads a Buffer; handed a bare Uint8Array it decides the argument is
    // a URL and goes looking for a host named after the first byte.
    const image = await Jimp.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    // Only ever down, and in place. `scaleToFit` fits the box in both
    // directions, so an icon would come back blown up to 640 and heavier than
    // the file it came from — the browser's `fit()` clamps the scale at 1 for
    // the same reason.
    if (Math.max(image.width, image.height) > THUMBNAIL_MAX_EDGE) {
      image.scaleToFit({ w: THUMBNAIL_MAX_EDGE, h: THUMBNAIL_MAX_EDGE });
    }
    for (const quality of QUALITY_STEPS) {
      const jpeg = await image.getBuffer('image/jpeg', { quality });
      const uri = PREFIX + Buffer.from(jpeg).toString('base64');
      if (uri.length <= THUMBNAIL_MAX_BYTES) return uri;
    }
    return undefined;
  } catch {
    // An unsupported codec, a truncated file, a name that lies about its type.
    return undefined;
  }
}
