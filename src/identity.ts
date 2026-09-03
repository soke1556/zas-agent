// Everything the agent keeps on disk. One directory per profile, so a machine
// can hold a Claude Code agent and a Codex agent side by side without either
// reading the other's keys. Nothing here talks to the network.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { x25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/nist.js';
import type { AgentKind } from './shared/agent.js';
import { bytesToB64 } from './shared/hash.js';
import { ZasError } from './errors.js';

export interface Identity {
  version: 1;
  agent_uid: string;
  owner_uid: string;
  name: string;
  kind: AgentKind;
  host: string;
  /** base64. The X25519 pair unwraps channel keys; the P-256 pair signs sign-in challenges. */
  x25519_private: string;
  x25519_public: string;
  p256_private: string;
  p256_public: string;
  api_base: string;
  token_base: string;
  oprf_base: string;
  firestore_project: string;
}

/** A pairing the owner has not approved yet: the same key material as an
 *  Identity, minus the uids the server only hands back at approval. */
export interface Pending {
  version: 1;
  profile: string;
  pairing_id: string;
  poll_secret: string;
  /** Protocol 1 only: the code the terminal printed. A protocol-2 pairing has none. */
  code?: string;
  fingerprint: string;
  expires_at: number;
  kind: AgentKind;
  host: string;
  x25519_private: string;
  x25519_public: string;
  p256_private: string;
  p256_public: string;
  api_base: string;
  token_base: string;
  oprf_base: string;
  firestore_project: string;
  created_at: number;
  /** 2 when this process claims its own pairing; `port` is where it listens. */
  protocol?: 2;
  port?: number;
}

/** Exactly the rows `GET /v1/agents/me` returns under `grants`. The channel
 *  name stays encrypted here; it is decrypted on demand, never cached in clear. */
export interface RemoteGrant {
  channel_id: string;
  send: boolean;
  read: boolean;
  wrapped_key: string;
  key_version: number;
  name_enc: string;
  mode: 'edit' | 'view';
  direct_mode: boolean;
}

export interface GrantCache {
  fetched_at: number;
  /** Which agent asked. A profile that was paired again holds a different uid,
   *  and the old rows are worse than useless: their wrapped keys will not open
   *  with the new X25519 key, and their channel ids would let a replay guard
   *  keyed on the old agent suppress the new agent's first send. */
  agent_uid: string;
  grants: RemoteGrant[];
}

/** What an earlier send of the same content, into the same channel, under the
 *  same title produced. Enough to answer a repeat without a single request.
 *  The channel name is deliberately absent: it is decrypted on demand and
 *  never written to disk in the clear. */
export interface SendReceipt {
  link_id: string;
  bytes: number;
  chunks: number;
  deduplicated: number;
  at: number;
}

export interface FingerprintCache {
  entries: Record<string, SendReceipt>;
}

const IDENTITY_FILE = 'identity.json';
const PENDING_FILE = 'pending.json';
const GRANTS_FILE = 'grants.json';
const FINGERPRINTS_FILE = 'fingerprints.json';

function agentHome(): string {
  return process.env.ZAS_AGENT_HOME || join(homedir(), '.zas', 'agent');
}

/** A profile is a directory name under `ZAS_AGENT_HOME` and nothing else. No
 *  separator, and no leading dot, so `--profile ../../elsewhere` cannot write
 *  key material outside the agent home and `--profile .` cannot mean it. The
 *  CLI checks the flag it is given; this is the check every read and write
 *  passes through, whoever called. */
export const PROFILE_RE = /^(?!\.)[A-Za-z0-9._-]{1,64}$/;

export function profileDir(profile: string): string {
  if (!PROFILE_RE.test(profile)) throw new ZasError('internal', 0, `Invalid profile: ${profile}`);
  return join(agentHome(), profile);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by the umask, and does nothing at all when the
  // directory already existed. Windows has no such bits to set.
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
}

/** Write through a temporary file so a crash mid-write cannot leave half an
 *  identity behind: either the old file stands or the new one does. The pid is
 *  in the name because two zas-agent processes can share one profile. */
function writePrivate(dir: string, name: string, value: unknown): void {
  ensureDir(dir);
  const target = join(dir, name);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, target);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Caches. A damaged one is no loss: the next call to /v1/agents/me rebuilds it. */
function readCache<T>(dir: string, name: string): T | null {
  const target = join(dir, name);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Key material. Absent means "never paired"; damaged means something is
 *  wrong, and reading it as "never paired" would quietly mint a second agent
 *  and orphan the uid the owner already approved. So it throws instead. */
function readSecret<T>(dir: string, name: string): T | null {
  const target = resolve(join(dir, name));
  const text = readText(target);
  if (text === null) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') throw new ZasError('identity_corrupt', 0, target);
  return parsed as T;
}

export function newKeyMaterial(): Pick<Identity, 'x25519_private' | 'x25519_public' | 'p256_private' | 'p256_public'> {
  const x = x25519.utils.randomSecretKey();
  const p = p256.utils.randomSecretKey();
  return {
    x25519_private: bytesToB64(x),
    x25519_public: bytesToB64(x25519.getPublicKey(x)),
    p256_private: bytesToB64(p),
    // Uncompressed: 65 bytes is what the server stores and verifies against.
    p256_public: bytesToB64(p256.getPublicKey(p, false)),
  };
}

export function loadIdentity(profile: string): Identity | null {
  return readSecret<Identity>(profileDir(profile), IDENTITY_FILE);
}

export function saveIdentity(profile: string, identity: Identity): void {
  writePrivate(profileDir(profile), IDENTITY_FILE, identity);
}

export function loadPending(profile: string): Pending | null {
  return readSecret<Pending>(profileDir(profile), PENDING_FILE);
}

export function savePending(profile: string, pending: Pending): void {
  writePrivate(profileDir(profile), PENDING_FILE, pending);
}

export function clearPending(profile: string): void {
  rmSync(join(profileDir(profile), PENDING_FILE), { force: true });
}

export function loadGrants(profile: string): GrantCache | null {
  return readCache<GrantCache>(profileDir(profile), GRANTS_FILE);
}

export function saveGrants(profile: string, cache: GrantCache): void {
  writePrivate(profileDir(profile), GRANTS_FILE, cache);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

/** A shape check, not a null check: a hand-edited or older `fingerprints.json`
 *  with no `entries` would otherwise make every later send throw a bare
 *  TypeError. The cache is disposable, so a file that does not look right is
 *  simply an empty one. */
export function loadFingerprints(profile: string): FingerprintCache {
  const cached = readCache<unknown>(profileDir(profile), FINGERPRINTS_FILE);
  if (!isPlainObject(cached) || !isPlainObject(cached.entries)) return { entries: {} };
  return { entries: cached.entries as Record<string, SendReceipt> };
}

export function saveFingerprints(profile: string, cache: FingerprintCache): void {
  writePrivate(profileDir(profile), FINGERPRINTS_FILE, cache);
}

/** Read at call time, not at import: tests and the emulator set these after
 *  the module is already loaded. */
export function defaultEndpoints(): Pick<Identity, 'api_base' | 'token_base' | 'oprf_base' | 'firestore_project'> {
  return {
    api_base: process.env.ZAS_API_BASE || 'https://zas.red/api',
    token_base: process.env.ZAS_TOKEN_BASE || 'https://zas.red/anon-token',
    oprf_base: process.env.ZAS_OPRF_BASE || 'https://zas.red/oprf',
    firestore_project: process.env.ZAS_FIREBASE_PROJECT || 'zas-me',
  };
}
