// The three lines an owner pastes into a terminal to pair an agent and then
// connect it, plus the profile <-> kind mapping the CLI uses to know which
// AgentKind a `--profile` value stands for.
import { agentSnippets } from './shared/agent-snippets.js';
import type { AgentKind } from './shared/agent.js';

/** The package name esbuild bakes in at build time (see build.mjs); outside
 *  a build (vitest, ts-node) the define does not exist, so this falls back
 *  to the published name rather than throwing on a missing global. */
export function packageName(): string {
  return typeof __ZAS_AGENT_PKG__ === 'string' ? __ZAS_AGENT_PKG__ : 'zas-agent';
}

// Use the same command builder as the onboarding popup.
export function pairSnippet(profile: string, windows = process.platform === 'win32'): string {
  return agentSnippets(profile, windows, packageName()).pair;
}

export function claudeSnippet(profile: string, windows = process.platform === 'win32'): string {
  return agentSnippets(profile, windows, packageName()).claude;
}

export function codexSnippet(profile: string, windows = process.platform === 'win32'): string {
  return agentSnippets(profile, windows, packageName()).codex;
}

export function kindForProfile(profile: string): AgentKind {
  if (profile === 'claude-code') return 'claude_code';
  if (profile === 'codex') return 'codex';
  return 'other';
}
