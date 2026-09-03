// Reliable delivery for a failed Direct transfer.
//
// R2 never receives a filename, MIME type, channel key, or plaintext byte.
// The sender encrypts independently authenticated 16 MiB parts; the small
// layout/key record is itself sealed with the channel key by Main before it is
// sent to the API. Independent parts make retries and bounded-memory streaming
// possible without weakening integrity.
// Named modules, not the barrel: the agent's public export follows imports,
// and the barrel would drag every shared policy file into the npm package.
import { b64ToBytes, bytesToB64 } from './hash.js';
import {
  directFallbackCipherSize,
  directFallbackPartCount,
  DIRECT_FALLBACK_PART_BYTES,
  DIRECT_FALLBACK_TAG_BYTES,
} from './direct.js';
import type { DirectMeta } from './direct-protocol.js';
import type { Sink } from './direct-engine.js';

export interface DirectFallbackMeta extends DirectMeta {
  v: 1;
  key_b64: string;
  nonce_b64: string;
  part_bytes: number;
  tag_bytes: number;
  part_count: number;
  cipher_size: number;
}

export interface UploadedFallbackPart {
  partNumber: number;
  etag: string;
}

export function createFallbackMeta(file: { name: string; size: number; type: string }): DirectFallbackMeta {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  return {
    v: 1,
    name: file.name,
    size: file.size,
    mime: file.type,
    key_b64: bytesToB64(key),
    nonce_b64: bytesToB64(nonce),
    part_bytes: DIRECT_FALLBACK_PART_BYTES,
    tag_bytes: DIRECT_FALLBACK_TAG_BYTES,
    part_count: directFallbackPartCount(file.size),
    cipher_size: directFallbackCipherSize(file.size),
  };
}

export function fallbackMetaOf(value: unknown): DirectFallbackMeta {
  const meta = value as Partial<DirectFallbackMeta> | null;
  if (
    !meta || meta.v !== 1 || typeof meta.name !== 'string' || meta.name.length === 0 ||
    typeof meta.mime !== 'string' || !Number.isSafeInteger(meta.size) || (meta.size ?? -1) < 0 ||
    typeof meta.key_b64 !== 'string' || typeof meta.nonce_b64 !== 'string' ||
    meta.part_bytes !== DIRECT_FALLBACK_PART_BYTES || meta.tag_bytes !== DIRECT_FALLBACK_TAG_BYTES ||
    meta.part_count !== directFallbackPartCount(meta.size!) ||
    meta.cipher_size !== directFallbackCipherSize(meta.size!)
  ) throw new Error('bad_fallback_meta');
  let key: Uint8Array;
  let nonce: Uint8Array;
  try {
    key = b64ToBytes(meta.key_b64);
    nonce = b64ToBytes(meta.nonce_b64);
  } catch {
    throw new Error('bad_fallback_meta');
  }
  if (key.length !== 32 || nonce.length !== 8) throw new Error('bad_fallback_meta');
  return meta as DirectFallbackMeta;
}

function partPlainBytes(meta: DirectFallbackMeta, partNumber: number): number {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > meta.part_count) {
    throw new Error('bad_fallback_part');
  }
  if (partNumber < meta.part_count) return meta.part_bytes;
  return meta.size - meta.part_bytes * (meta.part_count - 1);
}

export function fallbackCipherPartBytes(meta: DirectFallbackMeta, partNumber: number): number {
  return partPlainBytes(meta, partNumber) + meta.tag_bytes;
}

export function fallbackCipherOffset(meta: DirectFallbackMeta, partNumber: number): number {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > meta.part_count) {
    throw new Error('bad_fallback_part');
  }
  return (partNumber - 1) * (meta.part_bytes + meta.tag_bytes);
}

function ivFor(meta: DirectFallbackMeta, partNumber: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(b64ToBytes(meta.nonce_b64), 0);
  new DataView(iv.buffer).setUint32(8, partNumber, false);
  return iv;
}

function aadFor(offerId: string, partNumber: number, plainBytes: number): Uint8Array {
  return new TextEncoder().encode(
    `zas-direct-fallback-v1\0${offerId}\0${partNumber}\0${plainBytes}`,
  );
}

async function aesKey(meta: DirectFallbackMeta): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    b64ToBytes(meta.key_b64) as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptFallbackPart(
  meta: DirectFallbackMeta,
  offerId: string,
  partNumber: number,
  plain: Uint8Array,
  key?: CryptoKey,
): Promise<Uint8Array> {
  const expected = partPlainBytes(meta, partNumber);
  if (plain.length !== expected) throw new Error('bad_fallback_part_size');
  const out = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivFor(meta, partNumber) as BufferSource,
      additionalData: aadFor(offerId, partNumber, plain.length) as BufferSource,
      tagLength: 128,
    },
    key ?? (await aesKey(meta)),
    plain as BufferSource,
  );
  return new Uint8Array(out);
}

export async function decryptFallbackPart(
  meta: DirectFallbackMeta,
  offerId: string,
  partNumber: number,
  cipher: Uint8Array,
  key?: CryptoKey,
): Promise<Uint8Array> {
  const plainBytes = partPlainBytes(meta, partNumber);
  if (cipher.length !== plainBytes + meta.tag_bytes) throw new Error('bad_fallback_part_size');
  const out = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivFor(meta, partNumber) as BufferSource,
      additionalData: aadFor(offerId, partNumber, plainBytes) as BufferSource,
      tagLength: 128,
    },
    key ?? (await aesKey(meta)),
    cipher as BufferSource,
  );
  return new Uint8Array(out);
}

const RETRIES = 3;
const URL_BATCH = 16;
const CONCURRENCY = 2;

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

/** One part's PUT to its signed URL, resolving the ETag. The web injects an
 *  XMLHttpRequest transport for upload progress; the agent injects fetch. */
export type PutPart = (
  url: string,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
  onLoaded: (loaded: number) => void,
) => Promise<string>;

export async function uploadFallback(options: {
  file: File;
  offerId: string;
  meta: DirectFallbackMeta;
  getUrls: (from: number, count: number) => Promise<{ part_number: number; url: string }[]>;
  onProgress?: (done: number, total: number) => void;
  onRetry?: () => void;
  signal?: AbortSignal;
  put: PutPart;
}): Promise<UploadedFallbackPart[]> {
  const { file, offerId, meta, signal } = options;
  fallbackMetaOf(meta);
  if (file.size !== meta.size || file.name !== meta.name) throw new Error('fallback_file_changed');
  const key = await aesKey(meta);
  const completed: UploadedFallbackPart[] = [];
  const partProgress = new Map<number, number>();
  const report = () => options.onProgress?.(
    Math.min(meta.cipher_size, [...partProgress.values()].reduce((sum, value) => sum + value, 0)),
    meta.cipher_size,
  );

  for (let first = 1; first <= meta.part_count; first += URL_BATCH) {
    aborted(signal);
    const count = Math.min(URL_BATCH, meta.part_count - first + 1);
    const signed = await options.getUrls(first, count);
    if (
      signed.length !== count ||
      signed.some((entry, i) => entry.part_number !== first + i || typeof entry.url !== 'string')
    ) throw new Error('bad_fallback_urls');
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, signed.length) }, async () => {
      for (;;) {
        const at = cursor++;
        if (at >= signed.length) return;
        const entry = signed[at];
        const partNumber = entry.part_number;
        const plainStart = (partNumber - 1) * meta.part_bytes;
        const plainEnd = Math.min(file.size, plainStart + meta.part_bytes);
        const plain = new Uint8Array(await file.slice(plainStart, plainEnd).arrayBuffer());
        const cipher = await encryptFallbackPart(meta, offerId, partNumber, plain, key);
        let etag = '';
        let lastError: unknown;
        for (let attempt = 0; attempt < RETRIES; attempt++) {
          aborted(signal);
          partProgress.set(partNumber, 0);
          report();
          try {
            etag = await options.put(entry.url, cipher, signal, (loaded) => {
              partProgress.set(partNumber, loaded);
              report();
            });
            break;
          } catch (error) {
            lastError = error;
            if ((error as Error).name === 'AbortError') throw error;
            if (attempt + 1 < RETRIES) {
              options.onRetry?.();
              await pause(250 * 2 ** attempt, signal);
            }
          }
        }
        if (!etag) throw lastError ?? new Error('fallback_put_failed');
        completed.push({ partNumber, etag });
      }
    });
    await Promise.all(workers);
  }
  return completed.sort((a, b) => a.partNumber - b.partNumber);
}

/** One continuous R2 response in the usual case. If the network drops, the
 * next request resumes at the last authenticated part boundary; a partial
 * encrypted part is discarded, so the sink never receives duplicate bytes. */
export async function downloadFallback(options: {
  offerId: string;
  meta: DirectFallbackMeta;
  sink: Sink;
  getUrl: () => Promise<string>;
  onProgress?: (done: number, total: number) => void;
  onRetry?: () => void;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<void> {
  const { meta, offerId, sink, signal } = options;
  fallbackMetaOf(meta);
  const key = await aesKey(meta);
  const fetcher = options.fetcher ?? fetch;
  let partNumber = 1;
  let plainDone = 0;
  let attempts = 0;
  try {
    while (partNumber <= meta.part_count) {
      aborted(signal);
      const cipherOffset = fallbackCipherOffset(meta, partNumber);
      try {
        const url = await options.getUrl();
        const response = await fetcher(url, {
          headers: cipherOffset > 0 ? { Range: `bytes=${cipherOffset}-` } : undefined,
          signal,
        });
        if (!response.ok || (cipherOffset > 0 && response.status !== 206) || !response.body) {
          throw new Error(`fallback_get_${response.status}`);
        }
        const reader = response.body.getReader();
        const held: Uint8Array[] = [];
        let heldBytes = 0;
        while (partNumber <= meta.part_count) {
          const needed = fallbackCipherPartBytes(meta, partNumber);
          while (heldBytes < needed) {
            const next = await reader.read();
            if (next.done) throw new Error('fallback_get_short');
            held.push(next.value);
            heldBytes += next.value.length;
          }
          const cipher = new Uint8Array(needed);
          let copied = 0;
          while (copied < needed) {
            const chunk = held.shift()!;
            const take = Math.min(chunk.length, needed - copied);
            cipher.set(chunk.subarray(0, take), copied);
            copied += take;
            heldBytes -= take;
            if (take < chunk.length) held.unshift(chunk.subarray(take));
          }
          const plain = await decryptFallbackPart(meta, offerId, partNumber, cipher, key);
          await sink.write(plain);
          plainDone += plain.length;
          partNumber++;
          attempts = 0;
          options.onProgress?.(plainDone, meta.size);
        }
        if (heldBytes > 0) throw new Error('fallback_get_long');
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        // Authentication failures are corruption or the wrong key, never a
        // flaky transport. Retrying the same authenticated bytes cannot help.
        if ((error as Error).name === 'OperationError' || (error as Error).message === 'fallback_get_long') {
          throw error;
        }
        attempts++;
        if (attempts >= RETRIES) throw error;
        options.onRetry?.();
        await pause(250 * 2 ** (attempts - 1), signal);
      }
    }
    if (plainDone !== meta.size) throw new Error('fallback_plain_size');
    await sink.close();
  } catch (error) {
    sink.abort?.();
    throw error;
  }
}
