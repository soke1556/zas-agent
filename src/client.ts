// The one place the agent talks to Zas. It holds no password and no account
// key: it proves who it is by signing a server challenge with its P-256 key,
// trades the answer for a custom token, and rides an ordinary Firebase ID
// token from there, exactly as a browser session would.
import { AGENT_TOKEN_TTL_SEC, signAgentChallenge } from './shared/agent.js';
import { b64ToBytes, bytesToB64 } from './shared/hash.js';
import { errorFromResponse, ZasError } from './errors.js';
import type { Identity } from './identity.js';

/** Sign in again this long before the token dies, so a request never starts
 *  with a token that expires while it is in flight. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type FetchLike = typeof fetch;

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A proxy or an error page can answer HTML. Treat it as an empty object so
    // the status still decides, and errorFromResponse still names the failure.
    return {};
  }
}

function jsonInit(method: string, body: unknown, headers: Record<string, string>): RequestInit {
  return {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** A call that carries no identity: the two sign-in routes, and the pairing
 *  routes an agent uses before it has a uid at all. `path` is the full one. */
export async function apiPublic<T>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  fetchImpl?: FetchLike,
): Promise<T> {
  const call = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const res = await call(`${base}${path}`, jsonInit(method, body, headers));
  const parsed = res.status === 204 ? undefined : await readBody(res);
  if (!res.ok) throw errorFromResponse(res.status, parsed);
  return parsed as T;
}

export class ZasClient {
  private readonly call: FetchLike;
  private readonly now: () => number;
  /** No refresh token: the agent re-signs in from its P-256 key, which it has
   *  on disk anyway, so keeping a long-lived credential in memory would buy
   *  nothing and widen what a crash dump holds. */
  private session: { idToken: string; expiresAt: number } | null = null;
  /** Concurrent callers wait on the one sign-in instead of racing three. */
  private pendingSignIn: Promise<void> | null = null;

  constructor(
    public readonly identity: Identity,
    opts: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.call = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
  }

  async signIn(): Promise<void> {
    const { agent_uid, owner_uid, token_base, p256_private } = this.identity;
    const chal = await apiPublic<{ challenge_id: string; nonce: string }>(
      token_base, 'POST', '/v1/agents/challenge', { agent_uid, owner_uid }, {}, this.call,
    );
    const signature = bytesToB64(
      signAgentChallenge(b64ToBytes(p256_private), agent_uid, chal.challenge_id, b64ToBytes(chal.nonce)),
    );
    const tok = await apiPublic<{ token: string; expires_in: number }>(
      token_base, 'POST', '/v1/agents/token',
      { agent_uid, owner_uid, challenge_id: chal.challenge_id, signature }, {}, this.call,
    );
    const res = await this.call(`${ZasClient.identityToolkitBase()}/accounts:signInWithCustomToken?key=${ZasClient.apiKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tok.token, returnSecureToken: true }),
    });
    if (!res.ok) throw new ZasError('sign_in_failed', res.status);
    const data = await res.json() as { idToken: string; expiresIn?: string };
    // A missing or unparsable expiresIn would leave the session looking fresh
    // forever. Fall back to the life the token function actually grants.
    const seconds = Number(data.expiresIn);
    const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : AGENT_TOKEN_TTL_SEC;
    this.session = { idToken: data.idToken, expiresAt: this.now() + ttl * 1000 };
  }

  async idToken(): Promise<string> {
    if (!this.session || this.session.expiresAt - this.now() <= REFRESH_MARGIN_MS) {
      await this.signInOnce();
    }
    return this.session!.idToken;
  }

  private async signInOnce(): Promise<void> {
    if (!this.pendingSignIn) {
      this.pendingSignIn = this.signIn().finally(() => { this.pendingSignIn = null; });
    }
    await this.pendingSignIn;
  }

  async api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.authedRetrying(`${this.identity.api_base}/v1${path}`, method, body, headers);
    const parsed = res.status === 204 ? undefined : await readBody(res);
    if (!res.ok) throw errorFromResponse(res.status, parsed);
    return parsed as T;
  }

  private async authed(url: string, method: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    const token = await this.idToken();
    return this.call(url, jsonInit(method, body, { Authorization: `Bearer ${token}`, ...headers }));
  }

  /** One authenticated call, with one fresh sign-in if the token is rejected.
   *  A 401 on a token the clock said was young means a revoked session or a
   *  server that restarted; both are fixed by signing in again, and neither is
   *  fixed by doing it twice. The API and the OPRF service both call through
   *  here, so a token that dies mid-send costs one retry, not the send. */
  private async authedRetrying(
    url: string,
    method: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    const res = await this.authed(url, method, body, headers);
    if (res.status !== 401) return res;
    // Drain the body first, or undici holds the connection open.
    await res.body?.cancel().catch(() => {});
    this.session = null;
    return this.authed(url, method, body, headers);
  }

  async oprfEvaluate(blinded: string[]): Promise<string[]> {
    const res = await this.authedRetrying(`${this.identity.oprf_base}/evaluate`, 'POST', { blinded }, {});
    const parsed = await readBody(res);
    if (!res.ok) throw errorFromResponse(res.status, parsed);
    return (parsed as { evaluated?: string[] }).evaluated ?? [];
  }

  /** Firestore REST runQuery. `parentPath` is relative to the documents root
   *  ('' for the root itself); the rows without a `document` are the read-time
   *  metadata Firestore interleaves, and they are dropped. */
  async firestoreRunQuery(parentPath: string, query: object): Promise<unknown[]> {
    const base = ZasClient.firestoreBase(this.identity.firestore_project);
    const url = `${base}${parentPath ? `/${parentPath}` : ''}:runQuery`;
    const res = await this.authed(url, 'POST', { structuredQuery: query }, {});
    const parsed = await readBody(res);
    if (!res.ok) throw errorFromResponse(res.status, parsed);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row): row is { document: unknown } => !!row && typeof row === 'object' && 'document' in row)
      .map((row) => row.document);
  }

  /** Firestore REST get of one document, `null` when it is not there. The
   *  rules decide what an agent may read; here that is its own Directo offer,
   *  which an offer's sender may read without a grant on the channel. */
  async firestoreGet(path: string): Promise<Record<string, unknown> | null> {
    const base = ZasClient.firestoreBase(this.identity.firestore_project);
    const res = await this.authed(`${base}/${path}`, 'GET', undefined, {});
    const parsed = await readBody(res);
    if (res.status === 404) return null;
    if (!res.ok) throw errorFromResponse(res.status, parsed);
    return parsed as Record<string, unknown>;
  }

  /** The web app's public config value. It identifies the project, it is not a secret. */
  static apiKey(): string {
    return process.env.ZAS_FIREBASE_API_KEY || 'AIzaSyAiZbAPrxH7EKaJftJoGcEVEL0h6rAVcvE';
  }

  static identityToolkitBase(): string {
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    return host ? `http://${host}/identitytoolkit.googleapis.com/v1` : 'https://identitytoolkit.googleapis.com/v1';
  }

  static firestoreBase(project: string): string {
    const host = process.env.FIRESTORE_EMULATOR_HOST;
    const root = host ? `http://${host}` : 'https://firestore.googleapis.com';
    return `${root}/v1/projects/${project}/databases/(default)/documents`;
  }
}
