// Release installation never touches a running package or a paired profile.
// A verified, immutable installation is selected only before opening stdio.
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHome, loadSettings, saveSettings } from './identity.js';

const DAY = 24 * 60 * 60 * 1000;
const REGISTRY = 'https://registry.npmjs.org';
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
interface Ready { version: string; directory: string }
interface State { checked_at?: number; ready?: Ready }
export interface UpdateDeps {
  fetch?: typeof fetch;
  install?: (directory: string, version: string, signal?: AbortSignal) => Promise<void>;
  verify?: (entry: string, version: string, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export function newerRelease(candidate: string, current: string): boolean {
  if (!RELEASE.test(candidate) || !RELEASE.test(current)) return false;
  const a = candidate.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function updatesEnabled(): boolean {
  const env = process.env.ZAS_AGENT_AUTO_UPDATE;
  if (env !== undefined) return env === '1';
  return loadSettings()?.auto_update !== false;
}

export function setUpdates(enabled: boolean): void {
  saveSettings({ ...loadSettings(), version: 1, auto_update: enabled });
}

export function isReleaseInstall(version: string, selfUrl: string): boolean {
  if (!RELEASE.test(version)) return false;
  const root = dirname(dirname(fileURLToPath(selfUrl)));
  // A monorepo package has its .git above this root; source archives may have
  // none at all. Published npm packages contain dist, never src/cli.ts.
  return !existsSync(join(root, '.git')) && !existsSync(join(root, 'src', 'cli.ts'));
}

const updateHome = () => resolve(agentHome(), '.updates');

function checkedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32'
    && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))) {
    throw new Error('Update directory must be owned by this user and not writable by others.');
  }
}

async function prepareHome(signal?: AbortSignal): Promise<string> {
  const home = updateHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  checkedDirectory(home);
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $dir=[Console]::In.ReadToEnd(); `
      + `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; `
      + `$acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); `
      + `$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); `
      + `$acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($dir,$acl)`;
    await new Promise<void>((done, fail) => {
      const child = execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15_000, signal, maxBuffer: 4096 },
        (error) => error ? fail(new Error('Could not protect the update directory.')) : done());
      child.stdin?.on('error', () => {}); // early process failure is reported by the callback
      child.stdin?.end(home);
    });
  }
  return home;
}

function readState(): State {
  try {
    checkedDirectory(updateHome());
    const value = JSON.parse(readFileSync(join(updateHome(), 'state.json'), 'utf8')) as State;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function writeState(home: string, state: State): void {
  const tmp = join(home, `state-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    renameSync(tmp, join(home, 'state.json'));
  } finally { rmSync(tmp, { force: true }); }
}

function releaseEntry(ready: Ready): string {
  if (!ready || !RELEASE.test(ready.version) || typeof ready.directory !== 'string'
    || !/^release-[a-f0-9-]{36}$/.test(ready.directory)) throw new Error('Invalid staged release.');
  let dir = updateHome();
  checkedDirectory(dir);
  for (const part of [ready.directory, 'node_modules', 'zas-agent', 'dist']) {
    dir = join(dir, part);
    checkedDirectory(dir);
  }
  const entry = join(dir, 'cli.js');
  const stat = lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid release entry point.');
  const pkg = JSON.parse(readFileSync(join(dirname(dir), 'package.json'), 'utf8'));
  if (pkg.name !== 'zas-agent' || pkg.version !== ready.version) throw new Error('Release version does not match.');
  return entry;
}

export function stagedRelease(current: string): { version: string; entry: string } | null {
  if (!updatesEnabled()) return null;
  try {
    const ready = readState().ready;
    return ready && newerRelease(ready.version, current) ? { version: ready.version, entry: releaseEntry(ready) } : null;
  } catch { return null; }
}

export async function verifiedStagedRelease(current: string): Promise<{ version: string; entry: string } | null> {
  const ready = stagedRelease(current);
  if (!ready) return null;
  try { await verify(ready.entry, ready.version); return ready; }
  catch { return null; } // e.g. an incomplete restore or a changed Node installation
}

export function updateLine(current: string): string {
  const ready = stagedRelease(current);
  return `Updates: ${updatesEnabled() ? 'on' : 'off'}${process.env.ZAS_AGENT_AUTO_UPDATE !== undefined ? ' (ZAS_AGENT_AUTO_UPDATE)' : ''}. Running ${current}.`
    + (ready ? ` ${ready.version} ready; restart the agent to use it.` : '');
}

/** Resolve npm's JS entry point so Windows never needs cmd.exe or shell quoting. */
export function npmCommand(): string[] {
  const candidates = [
    ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.env.PATH ?? '').split(delimiter).flatMap((dir) => [
      join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dir, 'npm'),
    ]),
  ];
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      if (path.endsWith(`${process.platform === 'win32' ? '\\' : '/'}npm-cli.js`)) return [process.execPath, path];
    } catch { /* try the next standard installation */ }
  }
  throw new Error('npm is required to install updates.');
}

/** All updater output is captured; none can enter the MCP stdout stream. */
export function runUpdateCommand(command: string[], cwd: string, signal?: AbortSignal, timeout = 180_000): Promise<string> {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) { reject(new Error('Update canceled.')); return; }
    const child = spawn(command[0], command.slice(1), { cwd, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', canceled = false;
    const stop = () => {
      canceled = true;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      }
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString().slice(0, 4096 - output.length); });
    child.on('error', () => { cleanup(); reject(new Error('Could not start the update command.')); });
    child.on('close', (code) => {
      cleanup();
      if (code === 0 && !canceled) resolveResult(output.trim());
      else reject(new Error(canceled ? 'Update canceled or timed out.' : 'Update installation or verification failed.'));
    });
  });
}

async function install(directory: string, version: string, signal?: AbortSignal): Promise<void> {
  writeFileSync(join(directory, 'package.json'), '{"private":true}', { mode: 0o600, flag: 'wx' });
  await runUpdateCommand([...npmCommand(), 'install', '--prefix', directory, '--no-save', '--no-audit', '--no-fund',
    '--engine-strict', '--progress=false', '--loglevel=error', `--registry=${REGISTRY}`, `zas-agent@${version}`], directory, signal);
}

async function verify(entry: string, version: string, signal?: AbortSignal): Promise<void> {
  if (await runUpdateCommand([process.execPath, entry, '--version'], dirname(entry), signal, 15_000) !== version) {
    throw new Error('The staged agent did not report the expected version.');
  }
}

/** force bypasses the interval and opt-out for an explicit `update` command. */
export async function checkForUpdate(current: string, force = false, signal?: AbortSignal, deps: UpdateDeps = {}): Promise<string> {
  if (!RELEASE.test(current)) return 'Development builds do not update themselves.';
  if (!force && !updatesEnabled()) return 'Automatic updates are off.';
  const now = (deps.now ?? Date.now)();
  let state = readState();
  if (!force && typeof state.checked_at === 'number' && now >= state.checked_at && now - state.checked_at < DAY) return '';
  const home = await prepareHome(signal);
  const lock = join(home, 'check.lock');
  // Live owners keep the lock; an interrupted process cannot disable updates forever.
  if (existsSync(lock)) {
    try {
      const pid = Number(readFileSync(lock, 'utf8'));
      // Installation has a three-minute timeout. A ten-minute lease also
      // recovers a truncated lock or a dead owner's subsequently reused PID.
      if (Date.now() - lstatSync(lock).mtimeMs < 10 * 60_000) {
        if (!Number.isInteger(pid) || pid <= 0) return 'Another update check is in progress.';
        try { process.kill(pid, 0); return 'Another update check is in progress.'; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'Another update check is in progress.'; }
      }
      rmSync(lock);
    } catch { return 'Another update check is in progress.'; }
  }
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { return 'Another update check is in progress.'; }
  try {
    state = readState();
    writeState(home, { ...state, checked_at: now });
    const response = await (deps.fetch ?? fetch)(`${REGISTRY}/zas-agent/latest`, {
      redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error('The npm registry is unavailable.');
    const latest = await response.json() as { name?: string; version?: string };
    if (latest?.name !== 'zas-agent' || typeof latest.version !== 'string' || !RELEASE.test(latest.version)) {
      throw new Error('The npm registry returned an invalid release.');
    }
    if (!newerRelease(latest.version, current)) return `Already up to date (${current}).`;
    if (state.ready && !newerRelease(latest.version, state.ready.version)) {
      try {
        const entry = releaseEntry(state.ready);
        await (deps.verify ?? verify)(entry, state.ready.version, signal);
        return `${state.ready.version} is ready for the next launch.`;
      } catch { /* repair a damaged installation */ }
    }
    const ready = { version: latest.version, directory: `release-${randomUUID()}` };
    const directory = join(home, ready.directory);
    mkdirSync(directory, { mode: 0o700 });
    // Retain incomplete installations for diagnosis. They are never selected.
    await (deps.install ?? install)(directory, ready.version, signal);
    const entry = releaseEntry(ready);
    await (deps.verify ?? verify)(entry, ready.version, signal);
    if (signal?.aborted) throw new Error('Update canceled.');
    writeState(home, { checked_at: now, ready });
    return `${ready.version} is ready. Restart the agent to use it.${updatesEnabled() ? '' : ' First enable updates with: zas-agent updates on'}`;
  } finally { rmSync(lock, { force: true }); }
}

export function startUpdateChecks(current: string, log: (line: string) => void): () => void {
  const controller = new AbortController();
  let checking = false;
  const check = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const result = await checkForUpdate(current, false, controller.signal);
      if (result.includes('ready')) log(`Zas update: ${result}`);
    } catch { if (!controller.signal.aborted) log('Zas update check failed; continuing with the current version.'); }
    finally { checking = false; }
  };
  const first = setTimeout(() => void check(), 5_000).unref();
  const interval = setInterval(() => void check(), DAY).unref();
  const terminate = () => { stop(); process.kill(process.pid, 'SIGTERM'); };
  const interrupt = () => { stop(); process.kill(process.pid, 'SIGINT'); };
  const stop = () => {
    clearTimeout(first); clearInterval(interval); controller.abort();
    process.stdin.removeListener('end', stop);
    process.removeListener('exit', stop);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
  };
  process.stdin.once('end', stop);
  process.once('exit', stop);
  process.once('SIGTERM', terminate);
  process.once('SIGINT', interrupt);
  return stop;
}

/** No shell and no stdio listeners in the parent: argv and protocol bytes pass intact. */
export function launchStaged(entry: string, argv: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry, ...argv], { stdio: 'inherit', windowsHide: true });
    const term = () => { child.kill('SIGTERM'); };
    const interrupt = () => { child.kill('SIGINT'); };
    process.once('SIGTERM', term); process.once('SIGINT', interrupt);
    const cleanup = () => { process.removeListener('SIGTERM', term); process.removeListener('SIGINT', interrupt); };
    child.once('error', () => { cleanup(); done(1); });
    child.once('exit', (code, signal) => { cleanup(); done(code ?? (signal === 'SIGINT' ? 130 : 143)); });
  });
}
