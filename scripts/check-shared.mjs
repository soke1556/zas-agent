#!/usr/bin/env node
// The public CI needs no credential for the private upstream repository.
// Git blob IDs pin exact upstream bytes; --source also verifies the manifest
// against the pinned commit in an available zas.web checkout.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pin = JSON.parse(readFileSync(resolve(root, 'shared-source.json'), 'utf8'));
if (pin.repository !== 'soke1556/zas.web' || !/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error('Invalid upstream pin');
const sourceIndex = process.argv.indexOf('--source');
const source = sourceIndex < 0 ? undefined : process.argv[sourceIndex + 1];
if (sourceIndex >= 0 && !source) throw new Error('--source needs a zas.web checkout');
for (const name of readdirSync(resolve(root, 'src/shared'))) {
  if (!Object.hasOwn(pin.files, `src/shared/${name}`)) throw new Error(`Unpinned shared module: ${name}`);
}
for (const [path, expected] of Object.entries(pin.files)) {
  if (!/^(src\/shared\/[\w.-]+\.ts|test\/fixtures\/[\w.-]+\.json)$/.test(path)) throw new Error(`Invalid pinned path: ${path}`);
  // Git checkouts may convert LF to CRLF on Windows; upstream blobs use LF.
  const bytes = Buffer.from(readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n'));
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Shared source drift: ${path} (pinned at ${pin.commit})`);
  if (source) {
    const upstream = path.replace('src/shared/', 'shared/src/').replace('test/fixtures/', 'shared/test/fixtures/');
    const blob = execFileSync('git', ['rev-parse', `${pin.commit}:${upstream}`], { cwd: source, encoding: 'utf8' }).trim();
    if (blob !== expected) throw new Error(`Upstream pin mismatch: ${path}`);
  }
}
console.log(`Shared modules and vectors match zas.web ${pin.commit}`);
