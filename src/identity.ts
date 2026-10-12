// Everything the agent keeps on disk. One directory per profile, so a machine
// can hold a Claude Code agent and a Codex agent side by side without either
// reading the other's keys. Nothing here talks to the network.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { x25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/nist.js';
import type { AgentKind } from './shared/agent.js';
import { bytesToB64 } from './shared/hash.js';
import { ZasError } from './errors.js';
import { validateBase, validateEndpoints, type Endpoints } from './endpoints.js';
import { checkedRef, loadSecrets, readPrivateText, removeSecrets, splitSecrets, storeSecrets } from './secret-store.js';

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
  /** Present, and true, on a grant for a channel of somebody else that its
   *  owner has not answered yet. The key is real and the row is not access:
   *  every server path tests the grant is active first. */
  pending?: boolean;
  /** The account this channel lives under, which is not this agent's owner
   *  when somebody else created the channel or an organization manages it.
   *  Absent from an older server, and then the owner's own account is the
   *  only account it ever granted. Read it through `channelAccountOf`. */
  channel_owner_uid?: string;
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
const SETTINGS_FILE = 'settings.json';

export function agentHome(): string {
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
 *  identity behind: either the old file stands or the new one does. A random
 *  name and exclusive creation keep concurrent writers from sharing a temp. */
function writePrivate(dir: string, name: string, value: unknown): void {
  ensureDir(dir);
  const target = join(dir, name);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } finally { rmSync(tmp, { force: true }); }
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
function readStored(dir: string, name: string): Record<string, unknown> | null {
  const target = resolve(join(dir, name));
  const text = readPrivateText(target);
  if (text === null) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ZasError('identity_corrupt', 0, target);
  return parsed as Record<string, unknown>;
}

function writeSecret(dir: string, name: string, value: Identity | Pending): void {
  validateEndpoints(value);
  const { publicData, secrets } = splitSecrets({ ...value });
  const previous = readStored(dir, name);
  ensureDir(dir);
  const ref = storeSecrets(dir, secrets);
  try { writePrivate(dir, name, { ...publicData, secret_ref: ref }); }
  catch (error) {
    try { removeSecrets(dir, ref); } catch { /* preserve the original error */ }
    throw error;
  }
  if (previous?.secret_ref) {
    try { removeSecrets(dir, previous.secret_ref); } catch { /* metadata already committed */ }
  }
}

function readSecret<T extends Identity | Pending>(dir: string, name: string): T | null {
  const stored = readStored(dir, name);
  if (!stored) return null;
  validateEndpoints(stored as unknown as Endpoints);
  if (stored.secret_ref) {
    const { secret_ref, ...publicData } = stored;
    const secrets = loadSecrets(dir, secret_ref);
    return { ...publicData, ...secrets } as unknown as T;
  }
  // Commit the replacement only after the OS store has accepted the keys.
  // A failure leaves the old JSON usable for recovery on the next run.
  splitSecrets(stored);
  writeSecret(dir, name, stored as unknown as T);
  return stored as unknown as T;
}

export function secretStorage(profile: string): string {
  const stored = readStored(profileDir(profile), IDENTITY_FILE) ?? readStored(profileDir(profile), PENDING_FILE);
  if (!stored) return 'not paired';
  if (!stored.secret_ref) return 'legacy file (migration pending)';
  const labels = { dpapi: 'Windows DPAPI (current user)', keychain: 'macOS Keychain', 'secret-service': 'Linux Secret Service', file: 'owner-only file (OS store unavailable)' };
  return labels[checkedRef(stored.secret_ref).backend];
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
  const identity = readSecret<Identity>(profileDir(profile), IDENTITY_FILE);
  if (identity) validateEndpoints(identity);
  return identity;
}

export function saveIdentity(profile: string, identity: Identity): void {
  writeSecret(profileDir(profile), IDENTITY_FILE, identity);
}

export function loadPending(profile: string): Pending | null {
  const pending = readSecret<Pending>(profileDir(profile), PENDING_FILE);
  if (pending) validateEndpoints(pending);
  return pending;
}

export function savePending(profile: string, pending: Pending): void {
  writeSecret(profileDir(profile), PENDING_FILE, pending);
}

export function clearPending(profile: string): void {
  const dir = profileDir(profile);
  const stored = readStored(dir, PENDING_FILE);
  rmSync(join(dir, PENDING_FILE), { force: true });
  if (stored?.secret_ref) removeSecrets(dir, stored.secret_ref);
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

/** What belongs to the machine rather than to one profile. A person decides
 *  about telemetry once, and pairing again — which rewrites a profile whole —
 *  must not undo that decision, so it lives next to the profile directories
 *  instead of inside one. */
export interface AgentSettings {
  version: 1;
  /** Automatic release checks and managed launch selection; absent means on. */
  auto_update?: boolean;
  /** Absent means nobody chose, which reads as on. */
  telemetry?: boolean;
  decided_at?: number;
  /** When the telemetry notice was last printed on this machine. */
  notified_at?: number;
}

/** Disposable, like the other caches: a damaged file is no settings at all,
 *  and the defaults stand. */
export function loadSettings(): AgentSettings | null {
  const stored = readCache<AgentSettings>(agentHome(), SETTINGS_FILE);
  return isPlainObject(stored) ? stored as AgentSettings : null;
}

export function saveSettings(settings: AgentSettings): void {
  writePrivate(agentHome(), SETTINGS_FILE, settings);
}

/** Read at call time, not at import: tests and the emulator set these after
 *  the module is already loaded. */
export function defaultEndpoints(): Pick<Identity, 'api_base' | 'token_base' | 'oprf_base' | 'firestore_project'> {
  const endpoints = {
    api_base: process.env.ZAS_API_BASE || 'https://zas.red/api',
    token_base: process.env.ZAS_TOKEN_BASE || 'https://zas.red/anon-token',
    oprf_base: process.env.ZAS_OPRF_BASE || 'https://zas.red/oprf',
    firestore_project: process.env.ZAS_FIREBASE_PROJECT || 'zas-me',
  };
  validateEndpoints(endpoints);
  if (process.env.ZAS_WEB_BASE) validateBase(process.env.ZAS_WEB_BASE, 'ZAS_WEB_BASE');
  return endpoints;
}
