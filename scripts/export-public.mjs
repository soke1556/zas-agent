#!/usr/bin/env node
// Produce the public mirror of this package: github.com/soke1556/zas-agent.
//
//   node scripts/export-public.mjs [target-dir] [--no-lock]
//
// The mirror is a plain npm package at its root. Everything in it comes from
// `agent/` in the private monorepo, except the nine `shared/src` modules the
// agent imports, which are copied under `src/shared/` and the imports rewritten
// to match. Nothing else from the monorepo travels, and the script fails rather
// than guessing when something outside `agent/` or `shared/src` appears in the
// bundle.
//
// esbuild's metafile is the authority on what to copy. A hand-written list
// would go stale the first time a new `shared` import is added, and the mirror
// would then be a package that does not build.
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildOptions } from '../build.mjs';

// `resolve`: `fileURLToPath` keeps the trailing separator, and a guard that
// compares it with a resolved path never fires.
const AGENT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_DIR = resolve(AGENT_DIR, '..');
const SHARED_PREFIX = '../shared/src/';

/** Tests that cannot run against the mirror alone, so shipping them would hand
 *  a contributor a suite that fails on a clean clone. `e2e.integration.test.ts`
 *  needs the Firebase emulator and the monorepo's functions;
 *  `export-public.test.ts` checks this script against `../shared`, which is the
 *  one directory the mirror by definition does not have. */
const TEST_EXCLUDE = new Set(['e2e.integration.test.ts', 'export-public.test.ts']);

/** Shared modules the mirror carries whether or not a copied file imports one.
 *  `keys.ts` is the channel-key derivation: the agent never runs it, because a
 *  grant hands it an already-unwrapped key, but the monorepo's end-to-end suite
 *  imports it and it is the one piece of the channel-key story a reader would
 *  otherwise have to take on trust. It costs two kilobytes and closes the
 *  question. */
const SHARED_ALWAYS = ['keys.ts'];

/** Everything copied verbatim from `agent/` to the target root. `public/` is
 *  the repo-only half: the files that only make sense once this package is a
 *  repository of its own, and that the monorepo itself must not grow. */
const COPY_FILES = ['build.mjs', 'tsconfig.json', 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];

const fail = (message) => { throw new Error(message); };

/** A path as the file system spells it, when it exists: the real case, and the
 *  long form of a Windows 8.3 name. A path that does not exist yet is only
 *  resolved. */
const canonical = (p) => {
  try { return realpathSync.native(p); } catch { return resolve(p); }
};

/** Why a target must not be exported into, or null. The export empties its
 *  target before writing it, so a target that is this package, the monorepo,
 *  or a directory the monorepo sits under would delete the files being
 *  exported. Exported for the test; the script has no other seam. */
export function forbiddenTarget(target) {
  const t = canonical(target);
  if (t === canonical(AGENT_DIR)) return 'it is this package';
  const repo = canonical(REPO_DIR);
  if (t === repo) return 'it is the monorepo';
  const rel = relative(t, repo);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return 'the monorepo is inside it';
  return null;
}

const toPosix = (p) => p.split(sep).join('/');

/** The package a bare import belongs to: `@noble/curves/nist.js` is
 *  `@noble/curves`, `hash-wasm` is itself. Anything relative or `node:` is not
 *  a dependency and never reaches here. */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Walk a metafile and split its inputs into agent sources and shared sources.
 *  Anything else is a file the mirror would not contain, and copying the
 *  bundle without it would produce a package that does not build — so it is a
 *  hard stop, not a warning. */
function classifyInputs(metafile, label) {
  const shared = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    if (input.startsWith('src/') || input.startsWith('test/')) continue;
    if (input.startsWith(SHARED_PREFIX)) {
      shared.add(input.slice(SHARED_PREFIX.length));
      continue;
    }
    fail(`${label}: input outside agent/ and shared/src/: ${input}`);
  }
  return shared;
}

/** Every bare package the bundle leaves external has to be declared, or `npm
 *  ci` in the mirror installs a package that cannot resolve its own imports at
 *  run time — and npm would not say so. */
function checkExternals(metafile, declared, label) {
  const missing = new Set();
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports ?? []) {
      if (!imported.external) continue;
      if (imported.path.startsWith('node:')) continue;
      if (imported.path.startsWith('.') || imported.path.startsWith('/')) continue;
      const name = packageOf(imported.path);
      if (!declared.has(name)) missing.add(`${name} (from ${imported.path})`);
    }
  }
  if (missing.size > 0) {
    fail(`${label}: imported but not in agent/package.json: ${[...missing].sort().join(', ')}`);
  }
}

/** Bare packages a bundle imports, by package name. */
function importedPackages(metafile) {
  const out = new Set();
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports ?? []) {
      if (!imported.external) continue;
      if (imported.path.startsWith('node:')) continue;
      if (imported.path.startsWith('.') || imported.path.startsWith('/')) continue;
      out.add(packageOf(imported.path));
    }
  }
  return out;
}

/** Tools the mirror runs by name and never imports, so no metafile can vouch
 *  for them: the compiler, the bundler, the test runner and Node's types. */
const TOOLCHAIN = new Set(['esbuild', 'typescript', 'vitest', '@types/node']);

/** devDependencies only the excluded end-to-end suite uses. Anything else the
 *  export would drop is a mistake somewhere — a tool wired through a config
 *  file rather than an import, say — so the export stops and names it. */
const MONOREPO_ONLY_DEV = new Set(['@aws-sdk/client-s3']);

/** The mirror's package.json is the monorepo's, minus what only makes sense
 *  there. The `export:*` scripts run this file and its check, which need
 *  `../shared` and `scripts/export-check.mjs`; the mirror has neither. A
 *  devDependency that no kept test imports and no tool needs is dead weight a
 *  reader cannot find a caller for — `@aws-sdk/client-s3` only ever served the
 *  fake S3 of the excluded end-to-end suite. Returns the names dropped. */
function writeMirrorPackage(target, pkg, testMetafile) {
  const used = importedPackages(testMetafile);
  const keep = (name) => TOOLCHAIN.has(name) || used.has(name);
  const dropped = Object.keys(pkg.devDependencies ?? {}).filter((name) => !keep(name));
  const unexplained = dropped.filter((name) => !MONOREPO_ONLY_DEV.has(name));
  if (unexplained.length > 0) {
    fail(`devDependencies with no importer in the mirror: ${unexplained.join(', ')} — `
      + 'add each to TOOLCHAIN or MONOREPO_ONLY_DEV in scripts/export-public.mjs, whichever is true');
  }
  const devDependencies = Object.fromEntries(Object.entries(pkg.devDependencies ?? {})
    .filter(([name]) => keep(name)));
  const scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {})
    .filter(([name]) => !name.startsWith('export:')));
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ ...pkg, scripts, devDependencies }, null, 2)}\n`);
  return dropped;
}

/** Not content: git's own store and an installed dependency tree. Descending
 *  into either would read tens of thousands of files to learn nothing. */
const NOT_CONTENT = new Set(['.git', 'node_modules']);

/** Files under a directory, as paths relative to it, POSIX-separated. */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_CONTENT.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(toPosix(relative(base, full)));
  }
  return out;
}

/** Empty the target of everything the export produces. The mirror is a full
 *  replacement, so a file that stopped being exported has to stop existing;
 *  git then shows the deletion in the diff instead of leaving an orphan.
 *
 *  Three things survive, and none of them is exported content: `.git`;
 *  `node_modules`, which the next `npm ci` replaces wholesale anyway; and
 *  `package-lock.json`, so step 5 updates the lockfile in place instead of
 *  re-resolving every transitive version from the registry on each export. */
const KEEP = new Set(['.git', 'node_modules', 'package-lock.json']);

function emptyTarget(target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(target)) {
    if (KEEP.has(entry)) continue;
    rmSync(join(target, entry), { recursive: true, force: true });
  }
}

/** `'../../shared/src/x.js'` is where the monorepo keeps these modules; in the
 *  mirror they live under `src/shared/`. The replacement is computed per file
 *  from its own depth, so a source file in a subdirectory gets the right number
 *  of `..` rather than a prefix that happens to work at the top level. */
function rewriteImports(target) {
  const sharedDir = join(target, 'src', 'shared');
  // `scripts/` holds this file, and this file quotes the very import prefix it
  // rewrites. Rewriting it would corrupt the copy the mirror shows, and
  // scanning it would fail the export on its own source code.
  const isCode = (rel) => !rel.startsWith('scripts/') && (rel.endsWith('.ts') || rel.endsWith('.mjs'));
  const files = walk(target).filter(isCode);
  let rewritten = 0;
  for (const rel of files) {
    const full = join(target, rel);
    const before = readFileSync(full, 'utf8');
    let prefix = toPosix(relative(dirname(full), sharedDir));
    if (!prefix.startsWith('.')) prefix = `./${prefix}`;
    const after = before
      .replaceAll("'../../shared/src/", `'${prefix}/`)
      .replaceAll('"../../shared/src/', `"${prefix}/`);
    if (after !== before) {
      writeFileSync(full, after);
      rewritten += 1;
    }
  }
  const survivors = walk(target)
    .filter((f) => !f.startsWith('.git/') && !f.startsWith('scripts/'))
    .filter((rel) => readFileSync(join(target, rel), 'utf8').includes('../../shared'));
  if (survivors.length > 0) fail(`monorepo-relative shared imports survived in: ${survivors.join(', ')}`);
  return rewritten;
}

/** Test helpers nothing in the mirror imports any more. `fake-s3.ts` only ever
 *  served the end-to-end suite, and a helper with no caller is dead weight in a
 *  repository whose whole point is that a reader can check it. A helper that
 *  only another helper imports is kept, so the scan repeats until a pass drops
 *  nothing. */
function pruneHelpers(target) {
  const testDir = join(target, 'test');
  const helpersDir = join(testDir, 'helpers');
  if (!existsSync(helpersDir)) return [];
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `'./helpers/x.js'` from a test, `'./x.js'` from a sibling helper.
  const imports = (body, stem) =>
    new RegExp(`['"](?:\\.\\.?/)*(?:helpers/)?${escapeRe(stem)}(?:\\.js|\\.ts)?['"]`).test(body);
  const dropped = [];
  for (;;) {
    const helpers = walk(helpersDir);
    const bodies = walk(testDir).map((rel) => ({ rel, body: readFileSync(join(testDir, rel), 'utf8') }));
    const unused = helpers.filter((rel) => {
      const stem = rel.replace(/\.ts$/, '');
      return !bodies.some(({ rel: from, body }) => from !== `helpers/${rel}` && imports(body, stem));
    });
    if (unused.length === 0) break;
    for (const rel of unused) {
      rmSync(join(helpersDir, rel), { force: true });
      dropped.push(`test/helpers/${rel}`);
    }
  }
  if (walk(helpersDir).length === 0) rmSync(helpersDir, { recursive: true, force: true });
  return dropped;
}

async function main() {
  const args = process.argv.slice(2);
  const noLock = args.includes('--no-lock');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = resolve(positional[0] ?? join(REPO_DIR, '..', 'zas-agent'));
  const why = forbiddenTarget(target);
  if (why) fail(`refusing to export into ${target}: ${why}`);

  const pkg = JSON.parse(readFileSync(join(AGENT_DIR, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const declaredWithDev = new Set([...declared, ...Object.keys(pkg.devDependencies ?? {})]);

  // 1. What the published bundle reads.
  const bundle = await build({ ...buildOptions(AGENT_DIR), write: false, metafile: true });
  const shared = classifyInputs(bundle.metafile, 'bundle');
  checkExternals(bundle.metafile, declared, 'bundle');

  // The tests are part of the mirror, and they import `shared` modules the
  // bundle does not (`keys.ts`). Bundling them too is the only way to learn
  // that without a second, hand-maintained list.
  const keptTests = walk(join(AGENT_DIR, 'test'))
    .filter((rel) => !TEST_EXCLUDE.has(rel))
    .filter((rel) => rel.endsWith('.test.ts'))
    .map((rel) => `test/${rel}`);
  const testBundle = await build({
    ...buildOptions(AGENT_DIR),
    entryPoints: keptTests,
    outfile: undefined,
    outdir: 'dist-export-check',
    write: false,
    metafile: true,
  });
  for (const mod of classifyInputs(testBundle.metafile, 'tests')) shared.add(mod);
  checkExternals(testBundle.metafile, declaredWithDev, 'tests');
  for (const mod of SHARED_ALWAYS) shared.add(mod);

  // 2. The tree.
  emptyTarget(target);
  cpSync(join(AGENT_DIR, 'src'), join(target, 'src'), { recursive: true });
  cpSync(join(AGENT_DIR, 'test'), join(target, 'test'), {
    recursive: true,
    filter: (src) => !TEST_EXCLUDE.has(toPosix(relative(join(AGENT_DIR, 'test'), src))),
  });
  const droppedHelpers = pruneHelpers(target);
  for (const name of COPY_FILES) {
    const from = join(AGENT_DIR, name);
    if (!existsSync(from)) fail(`missing ${name} in agent/`);
    cpSync(from, join(target, name));
  }
  const droppedDev = writeMirrorPackage(target, pkg, testBundle.metafile);
  // The repo-only half, and this script, so the mirror shows how it is made.
  cpSync(join(AGENT_DIR, 'public'), target, { recursive: true });
  mkdirSync(join(target, 'scripts'), { recursive: true });
  cpSync(fileURLToPath(import.meta.url), join(target, 'scripts', 'export-public.mjs'));

  // 3. The shared modules, under src/shared/.
  for (const rel of [...shared].sort()) {
    const from = join(REPO_DIR, 'shared', 'src', rel);
    if (!existsSync(from)) fail(`shared module missing: shared/src/${rel}`);
    const to = join(target, 'src', 'shared', rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  const rewritten = rewriteImports(target);

  // 4. The mirror has no `../shared` to typecheck.
  const tsconfigPath = join(target, 'tsconfig.json');
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  tsconfig.include = ['src', 'test'];
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);

  // 5. A lockfile, so `npm ci` works in the mirror and in its CI.
  if (!noLock) {
    // `shell: true` on Windows: since Node 20, execFileSync refuses to run a
    // .cmd directly (EINVAL), and npm on Windows is npm.cmd. The arguments are
    // literals, so there is nothing here for a shell to reinterpret.
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--package-lock-only', '--ignore-scripts'],
      { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' });
  }

  // 6. Say what was produced, so a run in CI is auditable from its log alone.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR }).toString().trim();
  const files = walk(target).filter((f) => !f.startsWith('.git/'));
  console.log(`zas-agent public export → ${target}`);
  console.log(`  source commit: ${head}`);
  console.log(`  files:         ${files.length}${noLock ? ' (no lockfile: --no-lock)' : ''}`);
  console.log(`  imports fixed: ${rewritten}`);
  console.log(`  shared:        ${[...shared].sort().join(' ')}`);
  if (droppedHelpers.length > 0) console.log(`  dropped:       ${droppedHelpers.join(' ')}`);
  if (droppedDev.length > 0) console.log(`  dev dropped:   ${droppedDev.join(' ')}`);
}

// A command when run, a module when the test imports `forbiddenTarget`. Both
// sides go through the real path: npm installs a bin as a symlink, and argv[1]
// then names the link while import.meta.url names the file.
const invokedDirectly = process.argv[1] !== undefined
  && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`export-public: ${err.message}`);
    process.exitCode = 1;
  });
}
