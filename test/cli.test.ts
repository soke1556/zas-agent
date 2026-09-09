// The executable's own two decisions: whether this process was started as the
// bin, and what the arguments meant. Both are offline and both have bitten:
// npm installs the bin as a symlink, and a profile is a directory name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isInvokedDirectly, main, noticeOnServe, parseArgs } from '../src/cli.js';
import { noticeShown, telemetryState } from '../src/telemetry.js';

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
      message: 'Invalid profile: ../../elsewhere',
    });
    expect(parseArgs(['--profile=.hidden']).command).toBe('invalid');
    expect(parseArgs(['--profile=a/b']).command).toBe('invalid');
    expect(parseArgs(['--profile=claude-code']).command).toBe('serve');

    const lines: string[] = [];
    expect(await main(['pair', '--profile', '../../elsewhere'], (line) => lines.push(line))).toBe(2);
    expect(lines.join('\n')).toContain('Invalid profile: ../../elsewhere');
  });

  it('reads the telemetry command and its one setting', () => {
    expect(parseArgs(['telemetry']).command).toBe('telemetry');
    expect(parseArgs(['telemetry']).telemetry).toBeUndefined();
    expect(parseArgs(['telemetry', 'off'])).toMatchObject({ command: 'telemetry', telemetry: 'off' });
    expect(parseArgs(['telemetry', 'on'])).toMatchObject({ command: 'telemetry', telemetry: 'on' });
    // A typo is a question the person has to see, not a silent no-op.
    expect(parseArgs(['telemetry', 'offf'])).toMatchObject({ command: 'invalid' });
    // A flag after it is not a setting.
    expect(parseArgs(['telemetry', '--profile', 'codex'])).toMatchObject({ command: 'telemetry', profile: 'codex' });
  });
});

describe('the telemetry command', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-agent-cli-telemetry-'));
    process.env.ZAS_AGENT_HOME = home;
    delete process.env.ZAS_AGENT_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('says what this machine reports, and what it collects', async () => {
    const lines: string[] = [];
    expect(await main(['telemetry'], (line) => lines.push(line))).toBe(0);
    const printed = lines.join('\n');
    expect(printed).toContain('telemetry: on (default)');
    expect(printed).toContain('to improve the product');
    expect(printed).toContain('Never file names, file contents, paths or channel names.');
    expect(printed).toContain('telemetry off');
  });

  it('turns it off, and says how to turn it back on', async () => {
    const lines: string[] = [];
    expect(await main(['telemetry', 'off'], (line) => lines.push(line))).toBe(0);
    expect(telemetryState()).toEqual({ on: false, source: 'file' });
    expect(lines.join('\n')).toContain('telemetry: off (zas-agent telemetry)');
    expect(lines.join('\n')).toContain('Nothing is sent.');

    lines.length = 0;
    expect(await main(['telemetry', 'on'], (line) => lines.push(line))).toBe(0);
    expect(telemetryState()).toEqual({ on: true, source: 'file' });
    expect(lines.join('\n')).toContain('telemetry: on (zas-agent telemetry)');
  });
});

// Serving must never die on the way in. The telemetry notice is a courtesy
// printed once per machine; recording that it was printed writes a file, and a
// machine where that write fails (a read-only home, a directory somebody else
// owns) would otherwise exit before the MCP client's `initialize` was
// answered — which the client reports as "connection closed", with the real
// reason only in a log nobody opens.
describe('the telemetry notice on the way into serving', () => {
  let home = '';
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zas-agent-cli-notice-'));
    home = join(dir, 'home');
    process.env.ZAS_AGENT_HOME = home;
  });

  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints once, and records that it did', () => {
    const lines: string[] = [];
    noticeOnServe((line) => lines.push(line));
    expect(lines.join('\n')).toContain('to improve the product');
    expect(noticeShown()).toBe(true);

    lines.length = 0;
    noticeOnServe((line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('still lets the server start when the record cannot be written', () => {
    // The agent home is a file: every directory creation under it fails.
    writeFileSync(home, 'not a directory');
    const lines: string[] = [];
    expect(() => noticeOnServe((line) => lines.push(line))).not.toThrow();
    expect(lines.join('\n')).toContain('to improve the product');
    expect(lines.join('\n')).toContain('Serving anyway');
  });
});
