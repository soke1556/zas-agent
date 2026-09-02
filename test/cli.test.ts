// The executable's own two decisions: whether this process was started as the
// bin, and what the arguments meant. Both are offline and both have bitten:
// npm installs the bin as a symlink, and a profile is a directory name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isInvokedDirectly, main, parseArgs } from '../src/cli.js';

describe('isInvokedDirectly', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zas-agent-cli-'));
    writeFileSync(join(dir, 'cli.js'), '');
    writeFileSync(join(dir, 'other.js'), '');
    mkdirSync(join(dir, 'bin'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is true through the symlink npm installs the bin as', (ctx) => {
    // `<prefix>/node_modules/.bin/zas-agent -> ../zas-agent/dist/cli.js`, and
    // Node puts the symlink in argv[1] while import.meta.url names the real
    // file. Comparing the two strings is what made the installed bin a no-op.
    const link = join(dir, 'bin', 'zas-agent');
    try {
      symlinkSync(join(dir, 'cli.js'), link);
    } catch {
      // A Windows host without Developer Mode cannot make one. The other two
      // cases still run; the POSIX install is covered wherever CI can link.
      ctx.skip();
      return;
    }
    expect(isInvokedDirectly(link, pathToFileURL(join(dir, 'cli.js')).href)).toBe(true);
  });

  it('is false for another file and for no argument at all', () => {
    const self = pathToFileURL(join(dir, 'cli.js')).href;
    expect(isInvokedDirectly(join(dir, 'other.js'), self)).toBe(false);
    expect(isInvokedDirectly(undefined, self)).toBe(false);
    // What vitest itself looks like: a path that is not this module.
    expect(isInvokedDirectly(join(dir, 'nothing-here.js'), self)).toBe(false);
  });
});

describe('parseArgs', () => {
  it('leaves a valueless --host undefined so the hostname default applies', () => {
    expect(parseArgs(['pair', '--host']).host).toBeUndefined();
    expect(parseArgs(['pair', '--host=']).host).toBeUndefined();
    expect(parseArgs(['pair', '--host', 'laptop']).host).toBe('laptop');
  });

  it('refuses a profile that is not a plain directory name', async () => {
    expect(parseArgs(['pair', '--profile', '../../elsewhere'])).toMatchObject({
      command: 'invalid',
      message: 'Perfil inválido: ../../elsewhere',
    });
    expect(parseArgs(['--profile=.hidden']).command).toBe('invalid');
    expect(parseArgs(['--profile=a/b']).command).toBe('invalid');
    expect(parseArgs(['--profile=claude-code']).command).toBe('serve');

    const lines: string[] = [];
    expect(await main(['pair', '--profile', '../../elsewhere'], (line) => lines.push(line))).toBe(2);
    expect(lines.join('\n')).toContain('Perfil inválido: ../../elsewhere');
  });
});
