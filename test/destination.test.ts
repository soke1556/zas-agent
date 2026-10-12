import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { destinationOf, publishDownload } from '../src/destination.js';

describe('download destination', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zas-destination-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it.each([
    ['../../a', 'a'], ['..\\..\\a', 'a'], ['C:x', 'C_x'], ['a:b.txt', 'a_b.txt'],
    ['CON', '_CON'], ['nul.txt', '_nul.txt'], ['x.', 'x'], ['\\\0', '_'],
    ['a'.repeat(400) + '.txt', 'a'.repeat(176) + '.txt'], ['..', 'fallback'],
  ])('contains and sanitizes %s', (raw, name) => {
    const { target } = destinationOf(dir, raw, 'fallback');
    expect(basename(target)).toBe(name);
    const rel = relative(dir, target);
    expect(isAbsolute(rel)).toBe(false);
    expect(rel.startsWith('..')).toBe(false);
  });
  it('never overwrites a file created after selecting the destination', () => {
    const { target } = destinationOf(dir, 'raced.txt', 'file');
    const tmp = join(dir, 'partial');
    writeFileSync(tmp, 'new');
    writeFileSync(target, 'competitor');
    const path = publishDownload(tmp, target);
    expect(path).toBe(join(dir, 'raced (1).txt'));
    expect(readFileSync(target, 'utf8')).toBe('competitor');
    expect(readFileSync(path, 'utf8')).toBe('new');
  });
  it('does not follow an existing destination symlink', (ctx) => {
    const victim = join(dir, 'victim');
    const target = join(dir, 'download');
    writeFileSync(victim, 'preserved');
    try { symlinkSync(victim, target); } catch { ctx.skip(); return; }
    const tmp = join(dir, 'partial');
    writeFileSync(tmp, 'new');
    expect(publishDownload(tmp, target)).toBe(join(dir, 'download (1)'));
    expect(readFileSync(victim, 'utf8')).toBe('preserved');
  });
  it('refuses an explicit file path containing Windows stream syntax', () => {
    expect(() => destinationOf(join(dir, 'file:stream'), 'ignored', 'file')).toThrowError(expect.objectContaining({ code: 'write_failed' }));
  });
});
