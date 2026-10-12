// RFC 9497, mode 0x01, ristretto255-SHA512. Base-mode derivation is frozen
// separately in oprf.ts so introducing proofs never changes legacy keys.
import { RistrettoPoint as Point } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import { concatBytes } from './hash.js';
import { expandMessageXmd, oprfFinalize, randomScalar, type BlindResult } from './oprf.js';

const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
const CONTEXT = 'OPRFV1-\x01-ristretto255-SHA512';
const utf8 = (s: string) => new TextEncoder().encode(s);
const size = (n: number) => new Uint8Array([n >>> 8, n & 255]);
const framed = (b: Uint8Array) => concatBytes(size(b.length), b);
const reduce = (s: bigint) => ((s % ORDER) + ORDER) % ORDER;
type Element = InstanceType<typeof Point>;
const multiply = (p: Element, s: bigint) => s === 0n ? Point.ZERO : p.multiply(s);

function le(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}
function scalarBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, n >>= 8n) out[i] = Number(n & 255n);
  return out;
}
function hashScalar(input: Uint8Array, label = 'HashToScalar-'): bigint {
  return reduce(le(expandMessageXmd(input, utf8(label + CONTEXT), 64)));
}
function point(bytes: Uint8Array): Element {
  try {
    if (bytes.length !== 32) throw new Error();
    const p = Point.fromHex(bytes);
    if (p.equals(Point.ZERO)) throw new Error();
    return p;
  } catch { throw new Error('invalid_oprf_element'); }
}

export function voprfKeyFromSeed(seed: Uint8Array, info = utf8('zas-dedupe-voprf-v1:dedupe-v1')): bigint {
  if (seed.length !== 32 || info.length > 65535) throw new Error('invalid_voprf_seed');
  for (let counter = 0; counter < 256; counter++) {
    const key = hashScalar(concatBytes(seed, framed(info), new Uint8Array([counter])), 'DeriveKeyPair');
    if (key !== 0n) return key;
  }
  throw new Error('invalid_voprf_seed');
}
export function voprfPublicKey(key: bigint): Uint8Array {
  if (key <= 0n || key >= ORDER) throw new Error('invalid_voprf_key');
  return Point.BASE.multiply(key).toRawBytes();
}
export function voprfBlind(input: Uint8Array, blind = randomScalar()): BlindResult {
  if (input.length > 65535 || blind <= 0n || blind >= ORDER) throw new Error('invalid_oprf_input');
  const p = Point.hashToCurve(expandMessageXmd(input, utf8('HashToGroup-' + CONTEXT), 64));
  if (p.equals(Point.ZERO)) throw new Error('invalid_oprf_input');
  return { blind, blindedElement: p.multiply(blind).toRawBytes() };
}
function composites(publicKey: Uint8Array, blinded: Uint8Array[], evaluated: Uint8Array[]): [Element, Element] {
  if (!blinded.length || blinded.length > 256 || blinded.length !== evaluated.length) throw new Error('invalid_oprf_batch');
  const seed = sha512(concatBytes(framed(publicKey), framed(utf8('Seed-' + CONTEXT))));
  let m = Point.ZERO;
  let z = Point.ZERO;
  for (let i = 0; i < blinded.length; i++) {
    const c = point(blinded[i]); const d = point(evaluated[i]);
    const coefficient = hashScalar(concatBytes(framed(seed), size(i), framed(blinded[i]), framed(evaluated[i]), utf8('Composite')));
    m = m.add(multiply(c, coefficient)); z = z.add(multiply(d, coefficient));
  }
  return [m, z];
}
function challenge(publicKey: Uint8Array, m: Element, z: Element, t2: Element, t3: Element): bigint {
  return hashScalar(concatBytes(framed(publicKey), ...[m, z, t2, t3].map((p) => framed(p.toRawBytes())), utf8('Challenge')));
}

export function voprfEvaluate(key: bigint, blinded: Uint8Array[], proofRandom = randomScalar()): { evaluated: Uint8Array[]; proof: Uint8Array; publicKey: Uint8Array } {
  if (!blinded.length || blinded.length > 256 || proofRandom <= 0n || proofRandom >= ORDER) throw new Error('invalid_oprf_batch');
  const publicKey = voprfPublicKey(key);
  const evaluated = blinded.map((b) => point(b).multiply(key).toRawBytes());
  const [m, z] = composites(publicKey, blinded, evaluated);
  const c = challenge(publicKey, m, z, Point.BASE.multiply(proofRandom), multiply(m, proofRandom));
  return { publicKey, evaluated, proof: concatBytes(scalarBytes(c), scalarBytes(reduce(proofRandom - c * key))) };
}

/** publicKey MUST come from a pinned client configuration, never the response. */
export function voprfVerify(publicKey: Uint8Array, blinded: Uint8Array[], evaluated: Uint8Array[], proof: Uint8Array): boolean {
  try {
    const pk = point(publicKey);
    if (proof.length !== 64) return false;
    const c = le(proof.slice(0, 32)); const s = le(proof.slice(32));
    if (c >= ORDER || s >= ORDER) return false;
    const [m, z] = composites(publicKey, blinded, evaluated);
    return challenge(publicKey, m, z, multiply(Point.BASE, s).add(multiply(pk, c)), multiply(m, s).add(multiply(z, c))) === c;
  } catch { return false; }
}

export function voprfFinalizeBatch(inputs: Uint8Array[], blinds: BlindResult[], evaluated: Uint8Array[], proof: Uint8Array, pinnedPublicKey: Uint8Array): Uint8Array[] {
  if (inputs.length !== blinds.length || !voprfVerify(pinnedPublicKey, blinds.map((b) => b.blindedElement), evaluated, proof)) throw new Error('invalid_voprf_proof');
  return inputs.map((input, i) => oprfFinalize(input, blinds[i].blind, evaluated[i]));
}
