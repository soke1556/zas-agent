import { expect, it } from 'vitest';
import { safeFileName, uniqueSafeFileName } from '../src/shared/filename.js';
import vectors from './fixtures/filename-v1.json' with { type: 'json' };

it.each(vectors)('normalizes $raw using the Android filename rule', ({raw, fallback, expected}) => {
  expect(safeFileName(raw, fallback)).toBe(expected);
});
it('does not trust the fallback and cannot collide after normalization or truncation', () => {
  expect(safeFileName('', '../CON')).toBe('_CON');
  const used = new Set<string>();
  expect(uniqueSafeFileName('../A.txt', 'file', used)).toBe('A.txt');
  expect(uniqueSafeFileName('a.txt', 'file', used)).toBe('a (1).txt');
  expect(uniqueSafeFileName('a (1).txt', 'file', used)).toBe('a (1) (1).txt');
  const long = 'x'.repeat(400) + '.pdf';
  uniqueSafeFileName(long, 'file', used);
  const duplicate = uniqueSafeFileName(long, 'file', used);
  expect(duplicate.length).toBe(180);
  expect(duplicate.endsWith(' (1).pdf')).toBe(true);
});
