import { describe, expect, it } from 'vitest';
import { claudeSnippet, codexSnippet, kindForProfile, packageName, pairSnippet } from '../src/snippets.js';

describe('snippets', () => {
  it('falls back to zas-agent for the package name outside a build', () => {
    // The esbuild `define` only exists in the bundled CLI; under vitest the
    // globals are absent, and packageName() must not throw.
    expect(packageName()).toBe('zas-agent');
  });

  it('builds the Claude Code install line', () => {
    expect(claudeSnippet('claude-code')).toBe('claude mcp add zas -- npx -y zas-agent --profile claude-code');
    expect(claudeSnippet('codex')).toBe('claude mcp add zas -- npx -y zas-agent --profile codex');
  });

  it('builds the Codex install line', () => {
    // `codex mcp add` writes ~/.codex/config.toml itself. One line a person
    // pastes beats a toml block a person edits, and it is the same shape as
    // the Claude Code line beside it.
    expect(codexSnippet('codex')).toBe('codex mcp add zas -- npx -y zas-agent --profile codex');
    expect(codexSnippet('claude-code')).toBe(
      'codex mcp add zas -- npx -y zas-agent --profile claude-code',
    );
  });

  it('builds the pairing line', () => {
    expect(pairSnippet('claude-code')).toBe('npx -y zas-agent pair --profile claude-code');
    expect(pairSnippet('trabajo')).toBe('npx -y zas-agent pair --profile trabajo');
  });

  it('keeps every snippet on one line, because a person pastes them', () => {
    for (const line of [pairSnippet('codex'), claudeSnippet('codex'), codexSnippet('codex')]) {
      expect(line).not.toContain('\n');
    }
  });

  it('maps a profile name to its agent kind', () => {
    expect(kindForProfile('claude-code')).toBe('claude_code');
    expect(kindForProfile('codex')).toBe('codex');
    expect(kindForProfile('something-else')).toBe('other');
  });
});
