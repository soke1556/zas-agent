import { linkSync, mkdtempSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeFileName } from './shared/filename.js';
import { ZasError } from './errors.js';

function contained(folder: string, name: string): string {
  const target = resolve(folder, name);
  const rel = relative(resolve(folder), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ZasError('write_failed', 0);
  }
  return target;
}

/** Sender-controlled names never become paths. An explicit caller path may
 * choose a directory, but its final component must still be a safe filename. */
export function destinationOf(dest: string | undefined, name: unknown, fallback: string): { target: string; created?: string } {
  const base = safeFileName(name, fallback);
  if (dest === undefined) {
    const created = mkdtempSync(join(tmpdir(), 'zas-agent-'));
    return { target: contained(created, base), created };
  }
  if (statSync(dest, { throwIfNoEntry: false })?.isDirectory()) return { target: contained(dest, base) };
  const leaf = basename(dest);
  if (!leaf || leaf !== safeFileName(leaf)) throw new ZasError('write_failed', 0);
  return { target: contained(dirname(dest), leaf) };
}

/** Publish complete bytes without replacing a file or following a symlink.
 * The link is the exclusive operation; checking existence beforehand cannot
 * provide that guarantee. The temporary must be on the same filesystem. */
export function publishDownload(tmp: string, target: string): string {
  const folder = dirname(target);
  const base = basename(target);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 17 ? base.slice(dot) : '';
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 0; n <= 100; n++) {
    const suffix = n ? ` (${n})` : '';
    const name = stem.slice(0, 180 - suffix.length - ext.length) + suffix + ext;
    const candidate = contained(folder, name);
    try { linkSync(tmp, candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    unlinkSync(tmp);
    return candidate;
  }
  throw new ZasError('write_failed', 0);
}
