#!/usr/bin/env node
// Compare a public checkout with its monorepo source without overwriting either.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) throw new Error('Usage: node scripts/check-agent-source.mjs --source <zas.web checkout>');
const upstream = resolve(process.argv[sourceIndex + 1]);
if (!existsSync(resolve(upstream, 'agent/src'))) throw new Error('Source must contain agent/src');
const posix = value => value.split(sep).join('/');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(dir, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const sourceFiles = dir => walk(dir).filter(path => path.endsWith('.ts')).map(path => posix(relative(dir, path))).sort();
const publicFiles = sourceFiles(resolve(root, 'src')).filter(path => !path.startsWith('shared/'));
const upstreamFiles = sourceFiles(resolve(upstream, 'agent/src'));
const failures = [];
for (const path of new Set([...publicFiles, ...upstreamFiles])) {
  if (!publicFiles.includes(path) || !upstreamFiles.includes(path)) failures.push(`src/${path} (missing)`);
}
// These two suites require the monorepo and are deliberately not exported.
// Every other test must exist on both sides, including tests newly added there.
const excludedTests = new Set(['e2e.integration.test.ts', 'export-public.test.ts']);
const portableTests = dir => sourceFiles(dir).filter(path => path.endsWith('.test.ts') && !excludedTests.has(path));
const publicTests = portableTests(resolve(root, 'test'));
const upstreamTests = portableTests(resolve(upstream, 'agent/test'));
for (const path of new Set([...publicTests, ...upstreamTests])) {
  if (!publicTests.includes(path) || !upstreamTests.includes(path)) failures.push(`test/${path} (missing)`);
}
const files = [...publicFiles.map(path => `src/${path}`), ...walk(resolve(root, 'test')).map(path => posix(relative(root, path)))];
for (const path of files) {
  const local = resolve(root, path), source = resolve(upstream, 'agent', path);
  if (!existsSync(source)) { failures.push(`${path} (missing upstream)`); continue; }
  let sharedPrefix = posix(relative(dirname(local), resolve(root, 'src/shared')));
  if (!sharedPrefix.startsWith('.')) sharedPrefix = `./${sharedPrefix}`;
  let sourcePrefix = posix(relative(dirname(source), resolve(upstream, 'shared/src')));
  if (!sourcePrefix.startsWith('.')) sourcePrefix = `./${sourcePrefix}`;
  const normalized = readFileSync(local, 'utf8').replaceAll('\r\n', '\n')
    .replaceAll(`'${sharedPrefix}/`, `'${sourcePrefix}/`)
    .replaceAll(`"${sharedPrefix}/`, `"${sourcePrefix}/`);
  if (normalized !== readFileSync(source, 'utf8').replaceAll('\r\n', '\n')) failures.push(path);
}
if (failures.length) throw new Error(`Agent source drift:\n${[...new Set(failures)].sort().join('\n')}`);
console.log(`Agent runtime and ${files.length - publicFiles.length} portable test files match ${upstream}`);
