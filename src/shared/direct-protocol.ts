// What actually crosses the data channel, and nothing else: one byte names
// the frame, the rest is payload. Pure functions over bytes — no DOM, no RTC —
// so every reading is unit-testable and both engines share one vocabulary.
//
// The wire needs no lengths or sequence numbers: SCTP with `ordered: true`
// delivers whole messages, in order, exactly once. A frame is a message.
import { DIRECT_CHUNK_BYTES } from './direct.js';

const FRAME_META = 0x01;
const FRAME_CHUNK = 0x02;
const FRAME_DONE = 0x03;
const FRAME_ABORT = 0x04;
const FRAME_CREDIT = 0x05;

/** What the receiver knows before the first chunk: enough to pick a place to
 *  put the file and to draw the row. `label` is the sender's device name. */
export interface DirectMeta {
  name: string;
  size: number;
  mime: string;
  label?: string;
}

/** The three fields both ends must agree on, read off the file itself.
 *  The offer document seals this before anybody claims it, and the engine
 *  sends the same reading on the wire once the channel opens; the receiver
 *  compares the two. One function so the two readings cannot drift - they
 *  did, and every file an agent offered failed on arrival for it.
 *
 *  `mime` has a default because a Blob is allowed to carry no type: a file
 *  opened by path in Node has none, and a browser gives none to an extension
 *  it does not know. `name` comes from a File; a plain Blob has none, so the
 *  caller passes the name it means. */
export function directMetaOf(file: Blob, fallbackName?: string): DirectMeta {
  return {
    name: (file as File).name || fallbackName || 'zas',
    size: file.size,
    mime: file.type || 'application/octet-stream',
  };
}

export interface DirectDigest {
  size: number;
  sha256: string;
}

export type Frame =
  | { type: 'meta'; meta: DirectMeta }
  | { type: 'chunk'; payload: Uint8Array }
  | { type: 'done'; digest?: DirectDigest }
  | { type: 'abort' }
  | { type: 'credit'; received: number };

export function encodeMeta(meta: DirectMeta): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(meta));
  const frame = new Uint8Array(1 + body.length);
  frame[0] = FRAME_META;
  frame.set(body, 1);
  return frame;
}

export function encodeChunk(bytes: Uint8Array): Uint8Array {
  // The header byte rides inside the same message, so the payload gives up
  // one byte to keep the whole message within what every browser's SCTP
  // accepts without fragmentation surprises.
  if (bytes.length > DIRECT_CHUNK_BYTES - 1) throw new Error('chunk_too_big');
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = FRAME_CHUNK;
  frame.set(bytes, 1);
  return frame;
}

export function encodeDone(digest?: DirectDigest): Uint8Array {
  if (!digest) return new Uint8Array([FRAME_DONE]);
  const body = new TextEncoder().encode(JSON.stringify(digest));
  const frame = new Uint8Array(1 + body.length);
  frame[0] = FRAME_DONE;
  frame.set(body, 1);
  return frame;
}

export function encodeCredit(received: number): Uint8Array {
  if (!Number.isSafeInteger(received) || received < 0) throw new Error('bad_credit');
  const body = new TextEncoder().encode(String(received));
  const frame = new Uint8Array(1 + body.length);
  frame[0] = FRAME_CREDIT;
  frame.set(body, 1);
  return frame;
}

export const DONE_FRAME: Uint8Array = encodeDone();
export const ABORT_FRAME: Uint8Array = new Uint8Array([FRAME_ABORT]);

/** Reads one incoming message. Anything outside the vocabulary throws — a
 *  peer speaking something else is a peer to disconnect from, not decode. */
export function parseFrame(data: ArrayBuffer | Uint8Array): Frame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) throw new Error('empty_frame');
  const payload = bytes.subarray(1);
  switch (bytes[0]) {
    case FRAME_META: {
      const meta = JSON.parse(new TextDecoder().decode(payload)) as DirectMeta;
      if (typeof meta.name !== 'string' || typeof meta.size !== 'number') {
        throw new Error('bad_meta');
      }
      return { type: 'meta', meta };
    }
    case FRAME_CHUNK:
      return { type: 'chunk', payload };
    case FRAME_DONE: {
      if (payload.length === 0) return { type: 'done' };
      const digest = JSON.parse(new TextDecoder().decode(payload)) as DirectDigest;
      if (
        !Number.isSafeInteger(digest.size) || digest.size < 0 ||
        typeof digest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(digest.sha256)
      ) throw new Error('bad_digest');
      return { type: 'done', digest };
    }
    case FRAME_ABORT:
      return { type: 'abort' };
    case FRAME_CREDIT: {
      const received = Number(new TextDecoder().decode(payload));
      if (!Number.isSafeInteger(received) || received < 0) throw new Error('bad_credit');
      return { type: 'credit', received };
    }
    default:
      throw new Error('unknown_frame');
  }
}
