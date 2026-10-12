import { expect, it } from 'vitest';
import { voprfBlind, voprfEvaluate, voprfFinalizeBatch, voprfKeyFromSeed, voprfPublicKey, voprfVerify } from '../src/shared/voprf.js';
import vector from './fixtures/voprf-rfc9497.json' with { type: 'json' };
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const scalar = (s: string) => BigInt('0x' + Buffer.from(s, 'hex').reverse().toString('hex'));

it('matches the RFC key derivation, blinding, batch proof and final outputs', () => {
  const key = voprfKeyFromSeed(bytes(vector.seed), bytes(vector.info));
  expect(key).toBe(scalar(vector.secret_key));
  expect(hex(voprfPublicKey(key))).toBe(vector.public_key);
  const inputs = vector.inputs.map(bytes);
  const blinds = inputs.map((input, i) => voprfBlind(input, scalar(vector.blinds[i])));
  expect(blinds.map((b) => hex(b.blindedElement))).toEqual(vector.blinded);
  const result = voprfEvaluate(key, blinds.map((b) => b.blindedElement), scalar(vector.proof_random));
  expect(result.evaluated.map(hex)).toEqual(vector.evaluated);
  expect(hex(result.proof)).toBe(vector.proof);
  expect(voprfFinalizeBatch(inputs, blinds, result.evaluated, result.proof, bytes(vector.public_key)).map(hex)).toEqual(vector.outputs);
});

it('refuses wrong keys, changed proofs, reordered/missing answers and noncanonical proof scalars', () => {
  const pk = bytes(vector.public_key); const blinded = vector.blinded.map(bytes); const evaluated = vector.evaluated.map(bytes); const proof = bytes(vector.proof);
  expect(voprfVerify(voprfPublicKey(7n), blinded, evaluated, proof)).toBe(false);
  for (let i = 0; i < proof.length; i++) {
    const changed = proof.slice(); changed[i] ^= 1;
    expect(voprfVerify(pk, blinded, evaluated, changed)).toBe(false);
  }
  expect(voprfVerify(pk, blinded, [...evaluated].reverse(), proof)).toBe(false);
  expect(voprfVerify(pk, blinded, evaluated.slice(1), proof)).toBe(false);
  expect(voprfVerify(pk, blinded, evaluated, new Uint8Array(64).fill(255))).toBe(false);
  expect(voprfVerify(pk, blinded, [new Uint8Array(32), evaluated[1]], proof)).toBe(false);
  expect(() => voprfEvaluate(7n, [new Uint8Array(32)])).toThrow('invalid_oprf_element');
  expect(() => voprfFinalizeBatch([], [], [], proof, pk)).toThrow('invalid_voprf_proof');
}, 30_000);

it('randomized valid proofs produce stable outputs across different blinds', () => {
  const input = new Uint8Array([1, 2, 3]); const key = voprfKeyFromSeed(new Uint8Array(32).fill(11));
  const run = () => { const blind = voprfBlind(input); const result = voprfEvaluate(key, [blind.blindedElement]);
    return voprfFinalizeBatch([input], [blind], result.evaluated, result.proof, result.publicKey)[0]; };
  expect(run()).toEqual(run());
});
