// Exercise the published bundle outside a checkout, with a local staged release.
// No network, real profile, global npm installation or release download is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = mkdtempSync(join(tmpdir(), 'zas-update-launch-'));
const home = join(stage, 'home');
const install = join(stage, 'installed');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const argv = ['--profile', 'codex', '--host', 'literal & $value with spaces'];
const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'update-check', version: '1' },
} }) + '\n';

async function run(entry, args, enabled, input = request) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [entry, ...args], { windowsHide: true,
      env: { ...process.env, ZAS_AGENT_HOME: home, ZAS_AGENT_AUTO_UPDATE: enabled, ZAS_AGENT_TELEMETRY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); fail(new Error('Update launch timed out.')); }, 20_000);
    child.on('error', (error) => { clearTimeout(timer); fail(error); });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

try {
  mkdirSync(join(install, 'dist'), { recursive: true });
  copyFileSync(join(root, 'dist', 'cli.js'), join(install, 'dist', 'cli.js'));
  writeFileSync(join(install, 'package.json'), '{"type":"module"}');
  symlinkSync(join(root, 'node_modules'), join(install, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 1, telemetry: false, notified_at: Date.now() }));
  const directory = `release-${randomUUID()}`;
  const pkg = join(home, '.updates', directory, 'node_modules', 'zas-agent');
  mkdirSync(join(pkg, 'dist'), { recursive: true, mode: 0o700 });
  writeFileSync(join(pkg, 'package.json'), '{"name":"zas-agent","version":"999.0.0","type":"module"}');
  writeFileSync(join(pkg, 'dist', 'cli.js'), `
    if (process.argv[2] === '--version') console.log('999.0.0');
    else { console.error(JSON.stringify(process.argv.slice(2))); process.stdin.pipe(process.stdout); }
  `);
  writeFileSync(join(home, '.updates', 'state.json'), JSON.stringify({ ready: { version: '999.0.0', directory } }));

  const entry = join(install, 'dist', 'cli.js');
  const handed = await run(entry, argv, '1');
  assert.equal(handed.code, 0, handed.stderr);
  assert.equal(handed.stdout, request, 'The MCP stream must pass through without updater output.');
  assert.deepEqual(JSON.parse(handed.stderr.trim()), argv, 'Arguments must survive handoff literally.');

  for (const [label, path, enabled] of [
    ['opt-out', entry, '0'], ['source checkout', join(root, 'dist', 'cli.js'), '1'],
  ]) {
    const result = await run(path, argv, enabled);
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).result.serverInfo.version, version, label);
  }

  writeFileSync(join(pkg, 'dist', 'cli.js'), 'console.log("broken release"); process.exitCode = 1;');
  const fallback = await run(entry, argv, '1');
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).result.serverInfo.version, version);
  assert.ok(!fallback.stdout.includes('broken release'));
  console.log('Update launch: staged handoff, literal argv, MCP stdout, opt-out, checkout and broken-release fallback passed.');
} finally {
  const owned = relative(resolve(tmpdir()), resolve(stage));
  if (!owned.startsWith('zas-update-launch-') || owned.includes('/') || owned.includes('\\')) throw new Error('Unsafe temporary path.');
  rmSync(stage, { recursive: true, force: true });
}
