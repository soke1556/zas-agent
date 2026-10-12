// The envelope is what makes the account key rotatable. If it ever stops
// recognising a legacy blob, every item sealed before versioning becomes
// unreadable — so the compatibility path is tested explicitly, including the
// nasty case where a random nonce happens to start with the magic byte.
import { describe, it, expect } from 'vitest';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import {
  sealManifest,
  openManifest,
  encryptChannelName,
  decryptChannelName,
  envelopeVersion,
  newManifest,
  KEY_VERSION_LEGACY,
  sealRawV2, openRaw,
} from '../src/shared/manifest.js';
import { concatBytes } from '../src/shared/hash.js';

const key = new Uint8Array(32).fill(7);
const sample = () =>
  newManifest({
    kind: 'text', name: '', mime: 'text/plain', size: 4,
    created_at: '2026-07-27T00:00:00Z', text: 'hola', chunks: [],
  });

/** Exactly how bytes were sealed before versioning existed. */
function legacySeal(k: Uint8Array, plain: Uint8Array, nonceFill?: number): Uint8Array {
  const nonce = new Uint8Array(24);
  if (nonceFill === undefined) crypto.getRandomValues(nonce);
  else nonce.fill(nonceFill);
  return concatBytes(nonce, xchacha20poly1305(k, nonce).encrypt(plain));
}

describe('versioned envelope', () => {
  it('opens v2 and authenticates every header byte without breaking generation-2 v1', () => {
    const plain = new TextEncoder().encode(JSON.stringify(sample()));
    const sealed = sealRawV2(key, 2, plain);
    expect(envelopeVersion(sealed)).toBe(2);
    expect(openManifest(key, sealed).text).toBe('hola');
    for (let i = 0; i < sealed.length; i++) {
      const changed = sealed.slice(); changed[i] ^= 1;
      expect(() => openRaw(key, changed)).toThrow();
    }
    expect(openManifest(key, sealManifest(key, sample(), 2)).text).toBe('hola');
    expect(() => openRaw(key, sealed.slice(0, 20))).toThrow();
  });
  it('reports the version without needing the key', () => {
    expect(envelopeVersion(sealManifest(key, sample(), 4))).toBe(4);
    expect(envelopeVersion(sealManifest(key, sample(), 200))).toBe(200);
  });

  it('round-trips at any version', () => {
    for (const v of [1, 2, 7, 255]) {
      const sealed = sealManifest(key, sample(), v);
      expect(envelopeVersion(sealed)).toBe(v);
      expect(openManifest(key, sealed).text).toBe('hola');
    }
  });

  it('rejects a version that cannot be expressed in the envelope', () => {
    expect(() => sealManifest(key, sample(), 0)).toThrow();
    expect(() => sealManifest(key, sample(), 256)).toThrow();
  });

  it('still opens bytes sealed before versioning existed', () => {
    const legacy = legacySeal(key, new TextEncoder().encode(JSON.stringify(sample())));
    expect(envelopeVersion(legacy)).toBe(KEY_VERSION_LEGACY);
    expect(openManifest(key, legacy).text).toBe('hola');
  });

  it('opens a legacy blob whose nonce starts with the magic byte', () => {
    // 0x5a is 'Z'. A legacy nonce filled with it looks versioned but is not;
    // the AEAD tag fails and the reader must fall back rather than give up.
    const legacy = legacySeal(key, new TextEncoder().encode(JSON.stringify(sample())), 0x5a);
    expect(legacy[0]).toBe(0x5a);
    expect(openManifest(key, legacy).text).toBe('hola');
  });

  it('channel names carry a version too', () => {
    const sealed = encryptChannelName(key, 'Trabajo', 3);
    expect(envelopeVersion(sealed)).toBe(3);
    expect(decryptChannelName(key, sealed)).toBe('Trabajo');
    const legacy = legacySeal(key, new TextEncoder().encode('Trabajo'));
    expect(decryptChannelName(key, legacy)).toBe('Trabajo');
  });

  it('the wrong key still fails at every version', () => {
    const wrong = new Uint8Array(32).fill(8);
    expect(() => openManifest(wrong, sealManifest(key, sample(), 2))).toThrow();
    expect(() => openManifest(wrong, legacySeal(key, new Uint8Array([1, 2, 3])))).toThrow();
  });
});
