// Filled in by esbuild's `define` at build time (see build.mjs) from the
// package's own name and version. Absent under vitest and under `tsc`
// run outside a build, so every reader must treat them as possibly undefined.
declare const __ZAS_AGENT_PKG__: string | undefined;
declare const __ZAS_AGENT_VERSION__: string | undefined;
