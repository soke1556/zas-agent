// The one bundle this package ships, and the one description of how it is
// built. `node build.mjs` writes it; `scripts/export-public.mjs` imports
// `buildOptions()` and runs the same build with `write: false, metafile: true`
// to learn which files the bundle actually reads. Two copies of these options
// would drift, and the export would then mirror a different set of files than
// the one npm publishes.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const AGENT_DIR = fileURLToPath(new URL('.', import.meta.url));

/** The esbuild options for the published bundle. `absWorkingDir` is set so the
 *  entry point, the outfile and every metafile key are the same whatever
 *  directory the caller happens to be in. */
export function buildOptions(root = AGENT_DIR) {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  return {
    absWorkingDir: root,
    entryPoints: ['src/cli.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    packages: 'external',
    outfile: 'dist/cli.js',
    banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    define: {
      __ZAS_AGENT_PKG__: JSON.stringify(pkg.name),
      __ZAS_AGENT_VERSION__: JSON.stringify(pkg.version),
    },
    logLevel: 'warning',
  };
}

// Only when this file is the program. Importing it must not write dist/.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build(buildOptions());
}
