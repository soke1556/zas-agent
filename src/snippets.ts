// The three lines an owner pastes into a terminal to pair an agent and then
// connect it, plus the profile <-> kind mapping the CLI uses to know which
// AgentKind a `--profile` value stands for.
import type { AgentKind } from './shared/agent.js';

/** The package name esbuild bakes in at build time (see build.mjs); outside
 *  a build (vitest, ts-node) the define does not exist, so this falls back
 *  to the published name rather than throwing on a missing global. */
export function packageName(): string {
  return typeof __ZAS_AGENT_PKG__ === 'string' ? __ZAS_AGENT_PKG__ : 'zas-agent';
}

// The web repeats these three lines in the agents dialog's onboarding card, as
// literals: the web bundle cannot import from this package. `AGENT_SNIPPETS`
// in `web/src/components/AgentOnboarding.tsx` holds the strings these three
// functions print for the `claude-code` and `codex` profiles, and must be
// changed whenever they are.
//
// All three are one line. A person copies them with one gesture and pastes
// them into a shell; a block of toml is a file to edit instead, and `codex
// mcp add` exists precisely so nobody has to.
export function pairSnippet(profile: string): string {
  return `npx -y ${packageName()} pair --profile ${profile}`;
}

// The separator is quoted on purpose. On Windows the npm install of `claude`
// and `codex` is a PowerShell script shim, and PowerShell keeps a bare `--`
// for itself, so the CLI saw `-y` as its own option and refused it
// ("unknown option '-y'"). A quoted "--" reaches the CLI in PowerShell,
// bash, zsh and cmd alike.
export function claudeSnippet(profile: string): string {
  return `claude mcp add zas "--" npx -y ${packageName()} --profile ${profile}`;
}

export function codexSnippet(profile: string): string {
  return `codex mcp add zas "--" npx -y ${packageName()} --profile ${profile}`;
}

export function kindForProfile(profile: string): AgentKind {
  if (profile === 'claude-code') return 'claude_code';
  if (profile === 'codex') return 'codex';
  return 'other';
}
