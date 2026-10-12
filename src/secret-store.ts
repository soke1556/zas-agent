// OS tools avoid adding a native addon to an npx package. Secrets travel on
// stdin, never in command arguments or child-process error messages.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZasError } from './errors.js';

export type SecretBackend = 'dpapi' | 'keychain' | 'secret-service' | 'file';
export interface SecretRef { backend: SecretBackend; id: string }
export type Secrets = Record<string, string>;
const SERVICE = 'red.zas.agent';
const SECRET_KEYS = ['x25519_private', 'p256_private', 'poll_secret', 'code'] as const;

export function splitSecrets(value: Record<string, unknown>): { publicData: Record<string, unknown>; secrets: Secrets } {
  const publicData = { ...value };
  delete publicData.secret_ref;
  const secrets: Secrets = {};
  for (const key of SECRET_KEYS) {
    if (typeof value[key] === 'string') secrets[key] = value[key];
    delete publicData[key];
  }
  if (!secrets.x25519_private || !secrets.p256_private) throw new ZasError('identity_corrupt', 0);
  return { publicData, secrets };
}

export function checkedRef(raw: unknown): SecretRef {
  const ref = raw as SecretRef | undefined;
  if (!ref || !['dpapi', 'keychain', 'secret-service', 'file'].includes(ref.backend)
    || typeof ref.id !== 'string' || !/^[a-f0-9-]{36}$/.test(ref.id)) throw new ZasError('identity_corrupt', 0);
  // Copying a protected profile to another OS never silently downgrades it.
  if ((ref.backend === 'dpapi' && process.platform !== 'win32')
    || (ref.backend === 'keychain' && process.platform !== 'darwin')
    || (ref.backend === 'file' && process.platform === 'win32')) throw new ZasError('secret_store_failed', 0);
  return ref;
}

/** Check the opened file, not just a prior stat, so swapping it for a symlink
 * cannot bypass POSIX permissions. Also reject hard links to secret files. */
export function readPrivateText(path: string): string | null {
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new ZasError('identity_permissions', 0, path);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32'
      && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      const fix = process.platform === 'win32' ? path : `${path}; run chmod 600 -- '${path.replaceAll("'", "'\\''")}'`;
      throw new ZasError('identity_permissions', 0, fix);
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function command(file: string, args: string[], input?: string): string {
  try {
    return execFileSync(file, args, { input, encoding: 'utf8', timeout: 15_000,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).trim();
  } catch { throw new ZasError('secret_store_failed', 0); }
}

function dpapi(input: string, decrypt: boolean, dir?: string): string {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; `
    + `$request=[Console]::In.ReadToEnd() | ConvertFrom-Json; `
    + (decrypt ? '' : `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; `
      + `$acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); `
      + `$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); `
      + `$acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($request.dir,$acl); `)
    + `$b=[Convert]::FromBase64String($request.data); `
    + `$out=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); `
    + `[Console]::Out.Write([Convert]::ToBase64String($out))`;
  return command(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], JSON.stringify({ data: input, dir }));
}

const secretPath = (dir: string, ref: SecretRef) => join(dir, `secret-${ref.id}.json`);

export function storeSecrets(dir: string, secrets: Secrets): SecretRef {
  const id = randomUUID();
  const encoded = Buffer.from(JSON.stringify(secrets)).toString('base64');
  let backend: SecretBackend;
  if (process.platform === 'win32') {
    backend = 'dpapi';
    const encrypted = dpapi(encoded, false, dir);
    writeFileSync(secretPath(dir, { backend, id }), encrypted, { mode: 0o600, flag: 'wx' });
  } else if (process.platform === 'darwin') {
    backend = 'keychain';
    // Interactive command input keeps the password out of `ps`. All fields
    // interpolated here are fixed ASCII, a UUID or base64, never shell code.
    command('/usr/bin/security', ['-i'], `add-generic-password -a ${id} -s ${SERVICE} -w ${encoded}\n`);
    // Interactive security can exit zero after a command failed. Verify the
    // write before removing the only recoverable copy of the identity.
    if (command('/usr/bin/security', ['find-generic-password', '-a', id, '-s', SERVICE, '-w']) !== encoded) {
      throw new ZasError('secret_store_failed', 0);
    }
  } else {
    // No session bus is the normal headless/CI case. When a desktop store is
    // present but locked or broken, fail rather than silently downgrade it.
    let available = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS || process.env.DISPLAY);
    if (available) {
      try { command('secret-tool', ['store', '--help']); }
      catch { available = false; }
    }
    backend = available ? 'secret-service' : 'file';
    if (available) {
      command('secret-tool', ['store', '--label=Zas agent', 'service', SERVICE, 'id', id], encoded);
      if (command('secret-tool', ['lookup', 'service', SERVICE, 'id', id]) !== encoded) throw new ZasError('secret_store_failed', 0);
    } else {
      writeFileSync(secretPath(dir, { backend, id }), encoded, { mode: 0o600, flag: 'wx' });
    }
  }
  return { backend, id };
}

export function loadSecrets(dir: string, raw: unknown): Secrets {
  const ref = checkedRef(raw);
  try {
    let encoded: string;
    if (ref.backend === 'keychain') encoded = command('/usr/bin/security', ['find-generic-password', '-a', ref.id, '-s', SERVICE, '-w']);
    else if (ref.backend === 'secret-service') encoded = command('secret-tool', ['lookup', 'service', SERVICE, 'id', ref.id]);
    else {
      const stored = readPrivateText(secretPath(dir, ref));
      if (stored === null) throw new ZasError('secret_store_failed', 0);
      encoded = ref.backend === 'dpapi' ? dpapi(stored, true) : stored;
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ZasError('secret_store_failed', 0);
    // Only key material can come from the store, never endpoints or identity
    // metadata that could redirect a restored identity's credentials.
    return splitSecrets(value as Record<string, unknown>).secrets;
  } catch (error) {
    if (error instanceof ZasError && error.code === 'identity_permissions') throw error;
    throw new ZasError('secret_store_failed', 0);
  }
}

export function removeSecrets(dir: string, raw: unknown): void {
  const ref = checkedRef(raw);
  if (ref.backend === 'keychain') command('/usr/bin/security', ['delete-generic-password', '-a', ref.id, '-s', SERVICE]);
  else if (ref.backend === 'secret-service') command('secret-tool', ['clear', 'service', SERVICE, 'id', ref.id]);
  else rmSync(secretPath(dir, ref), { force: true });
}
