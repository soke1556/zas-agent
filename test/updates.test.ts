import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSettings, saveSettings } from '../src/identity.js';
import { main, parseArgs } from '../src/cli.js';
import { checkForUpdate, isReleaseInstall, launchStaged, newerRelease, npmCommand, runUpdateCommand,
  setUpdates, stagedRelease, startUpdateChecks, updateLine, updatesEnabled, verifiedStagedRelease,
  type UpdateDeps } from '../src/updates.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'zas-updates-'));
  vi.stubEnv('ZAS_AGENT_HOME', home);
  delete process.env.ZAS_AGENT_AUTO_UPDATE;
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function release(version = '1.1.0'): UpdateDeps {
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify({ name: 'zas-agent', version }))),
    install: vi.fn(async (directory, installedVersion) => {
      const pkg = join(directory, 'node_modules', 'zas-agent');
      mkdirSync(join(pkg, 'dist'), { recursive: true, mode: 0o700 });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'zas-agent', version: installedVersion }));
      writeFileSync(join(pkg, 'dist', 'cli.js'), `console.log(${JSON.stringify(installedVersion)});`);
    }),
  };
}
const state = () => JSON.parse(readFileSync(join(home, '.updates', 'state.json'), 'utf8'));

describe('release policy and controls', () => {
  it('compares stable versions numerically and never downgrades or accepts npm selectors', () => {
    expect(newerRelease('1.10.0', '1.9.99')).toBe(true);
    expect(newerRelease('2.0.0', '1.99.99')).toBe(true);
    for (const version of ['1.0.0', '0.9.0', '1.2.0-beta.1', 'latest', '../x', '01.2.0', '1.2.0;echo bad']) {
      expect(newerRelease(version, '1.0.0')).toBe(false);
    }
    expect(newerRelease('1.0.0', '0.0.0-dev')).toBe(false);
  });

  it('preserves telemetry settings and gives the environment override precedence', async () => {
    saveSettings({ version: 1, telemetry: false, notified_at: 123 });
    expect(updatesEnabled()).toBe(true);
    const log = vi.fn();
    expect(await main(['updates', 'off'], log)).toBe(0);
    expect(loadSettings()).toMatchObject({ telemetry: false, notified_at: 123, auto_update: false });
    expect(updatesEnabled()).toBe(false);
    vi.stubEnv('ZAS_AGENT_AUTO_UPDATE', '1');
    expect(updatesEnabled()).toBe(true);
    expect(updateLine('1.0.0')).toContain('(ZAS_AGENT_AUTO_UPDATE)');
    vi.stubEnv('ZAS_AGENT_AUTO_UPDATE', '0');
    setUpdates(true);
    expect(updatesEnabled()).toBe(false);
    expect(parseArgs(['updates', 'nope']).command).toBe('invalid');
    expect(parseArgs(['update']).command).toBe('update');
  });

  it('leaves source checkouts and prerelease builds alone', async () => {
    mkdirSync(join(home, '.git'));
    const url = pathToFileURL(join(home, 'dist', 'cli.js')).href;
    expect(isReleaseInstall('1.0.0', url)).toBe(false);
    rmSync(join(home, '.git'), { recursive: true });
    expect(isReleaseInstall('1.0.0', url)).toBe(true);
    expect(isReleaseInstall('1.0.0-dev', url)).toBe(false);
    const deps = release();
    await checkForUpdate('0.0.0-dev', true, undefined, deps);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe('staging', () => {
  it('stages a runnable release, preserves pairing data, and selects it only for older launches', async () => {
    mkdirSync(join(home, 'codex'));
    writeFileSync(join(home, 'codex', 'identity.json'), 'pairing stays here');
    const deps = release();
    expect(await checkForUpdate('1.0.0', true, undefined, deps)).toContain('1.1.0 is ready');
    const ready = stagedRelease('1.0.0');
    expect(ready?.version).toBe('1.1.0');
    expect(await verifiedStagedRelease('1.0.0')).toEqual(ready);
    expect(stagedRelease('1.1.0')).toBeNull();
    expect(stagedRelease('2.0.0')).toBeNull();
    expect(readFileSync(join(home, 'codex', 'identity.json'), 'utf8')).toBe('pairing stays here');
    expect(deps.fetch).toHaveBeenCalledWith('https://registry.npmjs.org/zas-agent/latest', expect.objectContaining({ redirect: 'error' }));
    setUpdates(false);
    expect(stagedRelease('1.0.0')).toBeNull();
  });

  it('checks at most daily, with explicit checks bypassing the interval', async () => {
    const deps = { ...release('1.0.0'), now: () => 1_000_000_000 };
    await checkForUpdate('1.0.0', false, undefined, deps);
    await checkForUpdate('1.0.0', false, undefined, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    await checkForUpdate('1.0.0', true, undefined, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    await checkForUpdate('1.0.0', false, undefined, { ...deps, now: () => 1_000_000_000 + 86_400_000 });
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it('skips all network and installation work while disabled', async () => {
    setUpdates(false);
    const deps = release();
    await checkForUpdate('1.0.0', false, undefined, deps);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('preserves the working release on offline, installation and verification failures', async () => {
    await checkForUpdate('1.0.0', true, undefined, release());
    const previous = state().ready;
    const offline = { ...release('1.2.0'), fetch: vi.fn(async () => { throw new Error('offline'); }) };
    await expect(checkForUpdate('1.0.0', true, undefined, offline)).rejects.toThrow('offline');
    const broken = { ...release('1.2.0'), install: vi.fn(async () => { throw new Error('npm failed'); }) };
    await expect(checkForUpdate('1.0.0', true, undefined, broken)).rejects.toThrow('npm failed');
    const badVersion = release('1.2.0');
    const install = badVersion.install!;
    badVersion.install = async (...args) => {
      await install(...args);
      writeFileSync(join(args[0], 'node_modules', 'zas-agent', 'dist', 'cli.js'), 'console.log("wrong");');
    };
    await expect(checkForUpdate('1.0.0', true, undefined, badVersion)).rejects.toThrow('expected version');
    expect(state().ready).toEqual(previous);
    expect((await verifiedStagedRelease('1.0.0'))?.version).toBe('1.1.0');
  }, 20_000);

  it('rejects invalid registry metadata and a package whose metadata differs from the release', async () => {
    const deps = release('2.0.0;whoami');
    await expect(checkForUpdate('1.0.0', true, undefined, deps)).rejects.toThrow('invalid release');
    expect(deps.install).not.toHaveBeenCalled();
    const wrong = release();
    const install = wrong.install!;
    wrong.install = async (directory, version, signal) => {
      await install(directory, version, signal);
      writeFileSync(join(directory, 'node_modules', 'zas-agent', 'package.json'), '{"name":"other","version":"1.1.0"}');
    };
    await expect(checkForUpdate('1.0.0', true, undefined, wrong)).rejects.toThrow('does not match');
    expect(stagedRelease('1.0.0')).toBeNull();
  });

  it('never downgrades a newer staged release when an older launcher checks again', async () => {
    await checkForUpdate('1.0.0', true, undefined, release('2.0.0'));
    const deps = release('1.1.0');
    await checkForUpdate('1.0.0', true, undefined, deps);
    expect(deps.install).not.toHaveBeenCalled();
    expect(stagedRelease('1.0.0')?.version).toBe('2.0.0');
  });

  it('keeps concurrent profiles from installing twice', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const deps = release();
    const install = deps.install!;
    deps.install = async (...args) => { await waiting; await install(...args); };
    const first = checkForUpdate('1.0.0', true, undefined, deps);
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalled());
    expect(await checkForUpdate('1.0.0', true, undefined, deps)).toContain('in progress');
    finish();
    await first;
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not publish an aborted installation', async () => {
    const controller = new AbortController();
    const deps = release();
    deps.verify = async () => { controller.abort(); };
    await expect(checkForUpdate('1.0.0', true, controller.signal, deps)).rejects.toThrow('canceled');
    expect(stagedRelease('1.0.0')).toBeNull();
  });

  it('ignores corrupt state, path escapes and damaged executables at launch', async () => {
    mkdirSync(join(home, '.updates'), { mode: 0o700 });
    const path = join(home, '.updates', 'state.json');
    writeFileSync(path, 'not json');
    expect(stagedRelease('1.0.0')).toBeNull();
    writeFileSync(path, JSON.stringify({ ready: { version: '1.1.0', directory: '../../outside' } }));
    expect(stagedRelease('1.0.0')).toBeNull();
    await checkForUpdate('1.0.0', true, undefined, release());
    writeFileSync(stagedRelease('1.0.0')!.entry, 'process.exit(1);');
    expect(await verifiedStagedRelease('1.0.0')).toBeNull();
    await checkForUpdate('1.0.0', true, undefined, release());
    expect((await verifiedStagedRelease('1.0.0'))?.version).toBe('1.1.0');
  }, 15_000);

  it('recovers an expired lock left by an interrupted update', async () => {
    mkdirSync(join(home, '.updates'), { mode: 0o700 });
    const lock = join(home, '.updates', 'check.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(lock, old, old);
    await checkForUpdate('1.0.0', true, undefined, release());
    expect(stagedRelease('1.0.0')?.version).toBe('1.1.0');
  });
});

describe('process and transport isolation', () => {
  it('installs an exact official package into the staging prefix using npm without a shell', async () => {
    const npm = join(home, 'npm-cli.js');
    const record = join(home, 'npm-args.json');
    writeFileSync(npm, `
      const fs = require('node:fs'), path = require('node:path');
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(args));
      const prefix = args[args.indexOf('--prefix') + 1];
      const version = args.find(a => a.startsWith('zas-agent@')).slice('zas-agent@'.length);
      const pkg = path.join(prefix, 'node_modules', 'zas-agent');
      fs.mkdirSync(path.join(pkg, 'dist'), {recursive:true});
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name:'zas-agent',version}));
      fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), 'console.log(' + JSON.stringify(version) + ')');
      console.log('npm output must not enter MCP stdout');
    `);
    vi.stubEnv('npm_execpath', npm);
    const deps = release();
    delete deps.install;
    await checkForUpdate('1.0.0', true, undefined, deps);
    const args = JSON.parse(readFileSync(record, 'utf8')) as string[];
    expect(args).toContain('zas-agent@1.1.0');
    expect(args).toContain('--registry=https://registry.npmjs.org');
    expect(args).toContain('--engine-strict');
    expect(args[args.indexOf('--prefix') + 1]).toBe(join(home, '.updates', state().ready.directory));
    expect(stagedRelease('1.0.0')?.version).toBe('1.1.0');
  });

  it('finds npm without invoking a Windows command shell', () => {
    const command = npmCommand();
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toMatch(/npm-cli\.js$/);
  });

  it('captures child stdout, passes literal arguments, and reports process failure', async () => {
    const args = ['a b', '$SECRET', 'x&whoami', 'x"y', '`test`'];
    const output = await runUpdateCommand([process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], home);
    expect(JSON.parse(output)).toEqual(args);
    await expect(runUpdateCommand([process.execPath, '-e', 'process.exit(2)'], home)).rejects.toThrow('failed');
  });

  it('cancels an updater child instead of holding a closed MCP session open', async () => {
    await expect(runUpdateCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], home, undefined, 100)).rejects.toThrow('timed out');
  });

  it('hands argv to the next launch without a shell and preserves the exit code', async () => {
    const entry = join(home, 'fake-release.cjs');
    const out = join(home, 'args.json');
    writeFileSync(entry, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); process.exit(23);');
    const args = ['--profile', 'codex', '--host', 'a b & $c'];
    expect(await launchStaged(entry, [out, ...args])).toBe(23);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(args);
  });

  it('removes its schedule and shutdown hooks when the transport closes', () => {
    vi.useFakeTimers();
    const before = process.stdin.listenerCount('end');
    const stop = startUpdateChecks('1.0.0', vi.fn());
    expect(process.stdin.listenerCount('end')).toBe(before + 1);
    expect(vi.getTimerCount()).toBe(2);
    stop(); stop();
    expect(process.stdin.listenerCount('end')).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});
