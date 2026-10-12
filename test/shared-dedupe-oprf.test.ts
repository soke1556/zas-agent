import { expect, it } from 'vitest';
import { dedupePolicy, dedupeRequest, verifiedDedupeResponse, blindDedupe } from '../src/shared/dedupe-oprf.js';
import { voprfEvaluate, voprfPublicKey } from '../src/shared/voprf.js';
import { bytesToB64 } from '../src/shared/hash.js';

it('requires a client pin before selecting the server-advertised new mode', () => {
  expect(dedupePolicy(undefined, {})).toEqual({ mode: 0 });
  expect(() => dedupePolicy({ mode: 1, key_id: 'k1' }, {})).toThrow('invalid_voprf_configuration');
  expect(() => dedupePolicy({ mode: 1, key_id: '__proto__' }, {})).toThrow('invalid_voprf_configuration');
});
it('verifies the complete response with the pinned key before releasing evaluated points', () => {
  const policy = dedupePolicy({ mode: 1, key_id: 'k1' }, { k1: bytesToB64(voprfPublicKey(7n)) });
  const blinded = [blindDedupe(new Uint8Array([1]), policy).blindedElement];
  expect(dedupeRequest(blinded, policy)).toMatchObject({ mode: 1, key_id: 'k1' });
  const response = voprfEvaluate(7n, blinded);
  const wire = { mode: 1, key_id: 'k1', evaluated: response.evaluated.map(bytesToB64), proof: bytesToB64(response.proof) };
  expect(verifiedDedupeResponse(wire, blinded, policy)).toEqual(response.evaluated);
  for (const bad of [{ ...wire, mode: 0 }, { ...wire, proof: undefined }, { ...wire, key_id: 'other' }, { ...wire, evaluated: [] }]) {
    expect(() => verifiedDedupeResponse(bad, blinded, policy)).toThrow('invalid_voprf_proof');
  }
  const wrong = voprfEvaluate(9n, blinded);
  expect(() => verifiedDedupeResponse({ ...wire, evaluated: wrong.evaluated.map(bytesToB64), proof: bytesToB64(wrong.proof), public_key: bytesToB64(wrong.publicKey) }, blinded, policy)).toThrow('invalid_voprf_proof');
});
