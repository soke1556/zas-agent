import { describe, it, expect } from 'vitest';
import {
  oprfBlind,
  oprfEvaluate,
  oprfFinalize,
  hashToGroup,
  serverKeyFromSeed,
} from '../src/shared/oprf.js';
import { sha512 } from '@noble/hashes/sha2';
import { concatBytes } from '../src/shared/hash.js';
import invalidElements from './fixtures/oprf-invalid-elements.json' with { type: 'json' };

function i2osp2(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

describe('OPRF ristretto255-SHA512', () => {
  const seed = new Uint8Array(32).fill(7);
  const k = serverKeyFromSeed(seed);

  it.each(invalidElements.vectors)('rejects $name wire elements on both sides', ({ element_hex }) => {
    const element = new Uint8Array(Buffer.from(element_hex, 'hex'));
    expect(() => oprfEvaluate(k, element)).toThrow(invalidElements.client_error);
    expect(() => oprfFinalize(new Uint8Array([0]), 3n, element)).toThrow(invalidElements.client_error);
  });

  it('matches RFC 9497 appendix A.1.1.1', () => {
    const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
    const scalar = (hex: string) => BigInt('0x' + Buffer.from(hex, 'hex').reverse().toString('hex'));
    const blinded = bytes('609a0ae68c15a3cf6903766461307e5c8bb2f95e7e6550e1ffa2dc99e412803c');
    const evaluated = bytes('7ec6578ae5120958eb2db1745758ff379e77cb64fe77b0b2d8cc917ea0869c7e');
    expect(oprfEvaluate(scalar('5ebcea5ee37023ccb9fc2d2019f9d7737be85591ae8652ffa9ef0f4d37063b0e'), blinded)).toEqual(evaluated);
    expect(Buffer.from(oprfFinalize(bytes('00'), scalar('64d37aed22a27f5191de1c1d69fadb899d8862b58eb4220029e036ec4c1f6706'), evaluated)).toString('hex')).toBe('527759c3d9366f277d8c6020418d96bb393ba2afb20ff90df23fb7708264e2f3ab9135e3bd69955851de4b1f9fe8a0973396719b7912ba9ee8aa7d0b5e24bcf6');
  });

  it('blind -> evaluate -> finalize equals direct k*H(x) finalize', () => {
    const input = new TextEncoder().encode('hello zas');
    const { blind, blindedElement } = oprfBlind(input);
    const evaluated = oprfEvaluate(k, blindedElement);
    const output = oprfFinalize(input, blind, evaluated);

    // Direct: unblinded = k * HashToGroup(input)
    const direct = hashToGroup(input).multiply(k).toRawBytes();
    const expected = sha512(
      concatBytes(i2osp2(input.length), input, i2osp2(32), direct, new TextEncoder().encode('Finalize')),
    );
    expect(Buffer.from(output).toString('hex')).toBe(Buffer.from(expected).toString('hex'));
  });

  it('different blinds give the same final output', () => {
    const input = new TextEncoder().encode('same content');
    const r1 = oprfBlind(input);
    const r2 = oprfBlind(input);
    expect(Buffer.from(r1.blindedElement).toString('hex')).not.toBe(
      Buffer.from(r2.blindedElement).toString('hex'),
    );
    const o1 = oprfFinalize(input, r1.blind, oprfEvaluate(k, r1.blindedElement));
    const o2 = oprfFinalize(input, r2.blind, oprfEvaluate(k, r2.blindedElement));
    expect(Buffer.from(o1).toString('hex')).toBe(Buffer.from(o2).toString('hex'));
  });

  it('different inputs give different outputs', () => {
    const a = new TextEncoder().encode('a');
    const b = new TextEncoder().encode('b');
    const ra = oprfBlind(a);
    const rb = oprfBlind(b);
    const oa = oprfFinalize(a, ra.blind, oprfEvaluate(k, ra.blindedElement));
    const ob = oprfFinalize(b, rb.blind, oprfEvaluate(k, rb.blindedElement));
    expect(Buffer.from(oa).toString('hex')).not.toBe(Buffer.from(ob).toString('hex'));
  });
});
