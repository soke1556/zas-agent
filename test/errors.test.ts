import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorFromResponse, humanSentence, SIGN_IN_CODES, ZasError } from '../src/errors.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Every code the package builds, read off the sources at test time. A list
 *  written by hand goes stale the day a new file constructs a new code, and the
 *  first the owner hears of it is a bare server-shaped word at a terminal.
 *  Template-literal constructions — `pair.ts` builds two — are out of the
 *  scan's reach, so they are named explicitly below. */
function constructedCodes(): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(SRC)) {
    if (!entry.endsWith('.ts')) continue;
    const source = readFileSync(join(SRC, entry), 'utf8');
    for (const match of source.matchAll(/ZasError\(\s*(['"])([a-z_]+)\1/g)) found.add(match[2]);
  }
  return [...found].sort();
}

describe('errors', () => {
  it('renames the server codes the agent does not speak', () => {
    expect(errorFromResponse(403, { error: 'read_only' }).code).toBe('send_forbidden');
    expect(errorFromResponse(413, { error: 'file_too_large' }).code).toBe('file_too_big');
    expect(errorFromResponse(507, { error: 'storage_limit' }).code).toBe('quota_exceeded');
    expect(errorFromResponse(404, { error: 'unknown_channel' }).code).toBe('grant_missing');
    expect(errorFromResponse(429, { error: 'rate_limited' }).code).toBe('rate_limited');
    expect(errorFromResponse(500, 'not json at all').code).toBe('network');
  });

  it('collapses every code outside the closed set, and keeps the server word', () => {
    const refused = errorFromResponse(403, { error: 'proof_failed' });
    expect(refused.code).toBe('upload_failed');
    expect(refused.serverCode).toBe('proof_failed');
    expect(refused.message).toContain('proof_failed');

    expect(errorFromResponse(400, { error: 'bad_ids' }).code).toBe('upload_failed');
    // In the canonical closed set (shared/src/agent.ts), so it survives the
    // collapse even before it has a sentence of its own.
    expect(errorFromResponse(403, { error: 'agent_forbidden' }).code).toBe('agent_forbidden');
    expect(errorFromResponse(502, {}).code).toBe('network');
    expect(errorFromResponse(429, { error: 'rate_limited' }).code).toBe('rate_limited');
  });

  it('carries the retry hint when the server sends one', () => {
    expect(errorFromResponse(409, { error: 'in_use', retry_after_ms: 1500 }).retryAfterMs).toBe(1500);
    expect(errorFromResponse(409, { error: 'in_use' }).retryAfterMs).toBeUndefined();
    expect(errorFromResponse(409, { error: 'in_use', retry_after_ms: 'soon' }).retryAfterMs).toBeUndefined();
  });

  it('has a sentence for every code the package constructs, and every one it passes through', () => {
    const scanned = constructedCodes();
    // A scan that found nothing must not read as a package that emits nothing.
    expect(scanned.length).toBeGreaterThanOrEqual(10);
    // `SIGN_IN_CODES` survive `errorFromResponse` uncollapsed, so they reach
    // the MCP surface exactly as the server wrote them: a row each, or the
    // owner reads `bad_signature` at a terminal.
    expect(SIGN_IN_CODES.size).toBeGreaterThanOrEqual(6);
    // The closed set is exactly what has a sentence, so a code without one
    // reaches a terminal as a bare server-shaped word.
    for (const code of [...scanned, ...SIGN_IN_CODES, 'pairing_expired', 'pairing_cancelled']) {
      expect(humanSentence(new ZasError(code, 0)), code).not.toBe(`Zas answered ${code} (0).`);
    }
  });

  it('puts the damaged file path into the sentence', () => {
    const sentence = humanSentence(new ZasError('identity_corrupt', 0, '/home/x/.zas/agent/p/identity.json'));
    expect(sentence).toContain('/home/x/.zas/agent/p/identity.json');
    expect(sentence).not.toContain('{path}');
    expect(humanSentence(new ZasError('who_knows', 418))).toBe('Zas answered who_knows (418).');
  });

  it('prints a path with replacement patterns in it literally', () => {
    // `$&`, `$\`` and `$'` are replacement patterns to String.replace, and a
    // directory can be named any of them. The owner has to read back the path
    // they actually have on disk.
    const path = "/home/x/$&$'$`/identity.json";
    const sentence = humanSentence(new ZasError('identity_corrupt', 0, path));
    expect(sentence).toContain(path);
  });
});
