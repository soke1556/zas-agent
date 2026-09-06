import { describe, expect, it } from 'vitest';
import { claudeSnippet, codexSnippet, kindForProfile, packageName, pairSnippet } from '../src/snippets.js';

describe('snippets', () => {
  it('uses Windows shims and passes registration through cmd', () => {
    expect(pairSnippet('codex', true)).toBe('npx.cmd -y zas-agent@latest pair --profile codex');
    expect(codexSnippet('codex', true)).toBe('cmd /d /c codex mcp add zas "--" npx.cmd -y zas-agent@latest --profile codex');
    expect(claudeSnippet('claude-code', true)).toBe('cmd /d /c claude mcp add zas "--" npx.cmd -y zas-agent@latest --profile claude-code');
  });
  it('falls back to zas-agent for the package name outside a build', () => {
    // The esbuild `define` only exists in the bundled CLI; under vitest the
    // globals are absent, and packageName() must not throw.
    expect(packageName()).toBe('zas-agent');
  });

  it('builds the Claude Code install line', () => {
    expect(claudeSnippet('claude-code', false)).toBe('claude mcp add zas "--" npx -y zas-agent@latest --profile claude-code');
    expect(claudeSnippet('codex', false)).toBe('claude mcp add zas "--" npx -y zas-agent@latest --profile codex');
  });

  it('builds the Codex install line', () => {
    // `codex mcp add` writes ~/.codex/config.toml itself. One line a person
    // pastes beats a toml block a person edits, and it is the same shape as
    // the Claude Code line beside it.
    expect(codexSnippet('codex', false)).toBe('codex mcp add zas "--" npx -y zas-agent@latest --profile codex');
    expect(codexSnippet('claude-code', false)).toBe(
      'codex mcp add zas "--" npx -y zas-agent@latest --profile claude-code',
    );
  });

  it('builds the pairing line', () => {
    expect(pairSnippet('claude-code', false)).toBe('npx -y zas-agent@latest pair --profile claude-code');
    expect(pairSnippet('trabajo', false)).toBe('npx -y zas-agent@latest pair --profile trabajo');
  });

  it('keeps every snippet on one line, because a person pastes them', () => {
    for (const line of [pairSnippet('codex', false), claudeSnippet('codex', false), codexSnippet('codex', false)]) {
      expect(line).not.toContain('\n');
    }
  });

  it('maps a profile name to its agent kind', () => {
    expect(kindForProfile('claude-code')).toBe('claude_code');
    expect(kindForProfile('codex')).toBe('codex');
    expect(kindForProfile('something-else')).toBe('other');
  });
});
