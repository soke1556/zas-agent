import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairUrl, runPair, webOriginOf } from '../src/pair.js';
import { loadIdentity, loadPending, saveIdentity, newKeyMaterial, defaultEndpoints, type Identity } from '../src/identity.js';
import { verifyAgentChallenge } from '../src/shared/agent.js';
import { b64ToBytes } from '../src/shared/hash.js';

const NOW = 1_700_000_000_000;
const AGENT_UID = 'agent_' + 'A'.repeat(22);
/** Deliberately not «claude-code» or «codex»: the snippets have to name the
 *  profile the pairing created, whatever the owner called it. */
const PROFILE = 'mi-agente';

/** Mirrors the shape of the fake fetch in client.test.ts, extended with the
 *  two public pairing routes. The pairing key material is minted inside
 *  runPair, so the challenge/token handlers capture the P-256 key the
 *  pairing POST actually sent instead of assuming one ahead of time. */
function fakeFetch(
  pollAnswers: Array<Record<string, unknown>>, pollStatuses: number[] = [], claimTransportFailures = 0,
  /** An identity already on disk: its P-256 key signs the old agent's
   *  sign-in, and `status` is what the replacement route answers with (201
   *  when absent). */
  replacement?: { p256Public: string; status?: number },
) {
  const calls: string[] = [];
  const pollHeaders: string[] = [];
  const createBodies: Record<string, unknown>[] = [];
  const claims: { secret: string; code: string }[] = [];
  const replacementAuth: string[] = [];
  let capturedP256Public = '';
  let capturedX25519Public = '';
  let pollIndex = 0;
  let claimAttempts = 0;
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.endsWith('/v1/agents/me/pairings')) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      replacementAuth.push(headers.Authorization);
      if (replacement?.status) return json(replacement.status, { error: 'agent_revoked' });
      capturedP256Public = String(body.p256_public);
      capturedX25519Public = String(body.x25519_public);
      createBodies.push(body);
      return json(201, {
        pairing_id: 'p1',
        poll_secret: 'f'.repeat(64),
        expires_at: NOW + 10 * 60 * 1000,
        protocol: 2,
        fingerprint: 'ab12cd34ef567890' + '0'.repeat(48),
      });
    }
    if (url.endsWith('/v1/agents/pairings')) {
      capturedP256Public = String(body.p256_public);
      capturedX25519Public = String(body.x25519_public);
      createBodies.push(body);
      return json(201, {
        pairing_id: 'p1',
        poll_secret: 'f'.repeat(64),
        expires_at: NOW + 10 * 60 * 1000,
        protocol: 2,
        fingerprint: 'ab12cd34ef567890' + '0'.repeat(48),
      });
    }
    if (url.endsWith('/v1/agents/pairings/p1/poll')) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      pollHeaders.push(headers['X-Zas-Poll-Secret']);
      const answer = pollAnswers[Math.min(pollIndex, pollAnswers.length - 1)];
      const status = pollStatuses[Math.min(pollIndex, pollStatuses.length - 1)] ?? 200;
      pollIndex += 1;
      return json(status, answer);
    }
    if (url.endsWith('/v1/agents/pairings/p1/claim')) {
      claimAttempts += 1;
      // A transport failure, not a server answer: no status code, no body —
      // exactly what a dropped connection or a DNS failure looks like to
      // `apiPublic`, and unlike every other branch here, not a `Response`.
      if (claimAttempts <= claimTransportFailures) throw new TypeError('fetch failed');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      claims.push({ secret: headers['X-Zas-Poll-Secret'], code: String(body.code) });
      if (body.code === 'ABCDEFGH') return json(200, { status: 'claimed', agent_uid: AGENT_UID, owner_uid: 'owner-1' });
      return json(403, { error: 'claim_mismatch', attempts_left: 4 });
    }
    if (url.endsWith('/v1/agents/challenge')) {
      return json(200, { challenge_id: 'ch1', nonce: Buffer.alloc(32, 3).toString('base64') });
    }
    if (url.endsWith('/v1/agents/token')) {
      // The new key once the pairing exists; before that, only an identity
      // already on disk can sign — which is what a replacement does first.
      const signedBy = (pub: string) => {
        try {
          return verifyAgentChallenge(
            b64ToBytes(pub), b64ToBytes(String(body.signature)), String(body.agent_uid), String(body.challenge_id), Buffer.alloc(32, 3),
          );
        } catch {
          return false;
        }
      };
      const ok = signedBy(capturedP256Public) || (replacement ? signedBy(replacement.p256Public) : false);
      return ok ? json(200, { token: 'custom-1', expires_in: 3600 }) : json(403, { error: 'bad_signature' });
    }
    if (url.includes('accounts:signInWithCustomToken')) {
      return json(200, { idToken: 'id-1', refreshToken: 'r-1', expiresIn: '3600' });
    }
    if (url.endsWith('/v1/agents/me')) {
      return json(200, {
        agent_uid: AGENT_UID, owner_uid: 'owner-1', name: 'Claude Code', kind: 'claude_code', status: 'active', grants: [],
      });
    }
    return json(404, { error: 'not_found' });
  });

  return {
    fetchImpl, calls, pollHeaders, createBodies, claims, replacementAuth,
    x25519Public: () => capturedX25519Public,
    claimAttempts: () => claimAttempts,
  };
}

describe('runPair', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'zas-agent-pair-')); process.env.ZAS_AGENT_HOME = home; });
  afterEach(() => { delete process.env.ZAS_AGENT_HOME; rmSync(home, { recursive: true, force: true }); });

  /** The base options every new test starts from. */
  const baseOpts = (f: ReturnType<typeof fakeFetch>, logLines: string[]) => ({
    profile: PROFILE,
    kind: 'claude_code' as const,
    webBase: 'https://zas.red',
    apiBase: 'https://zas.red/api',
    fetch: f.fetchImpl as unknown as typeof fetch,
    log: (line: string) => logLines.push(line),
    now: () => NOW,
  });

  it('prints the pairing block, keeps a pending file until approval, then saves the identity', async () => {
    const f = fakeFetch([{ status: 'pending' }, { status: 'pending' }, { status: 'claimed', agent_uid: AGENT_UID, owner_uid: 'owner-1' }]);
    const logLines: string[] = [];
    const sleepCalls: number[] = [];
    let checkedPendingDuringPoll = false;

    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
      if (!checkedPendingDuringPoll) {
        checkedPendingDuringPoll = true;
        const pending = loadPending(PROFILE);
        expect(pending).not.toBeNull();
        expect(pending!.x25519_public).toBe(f.x25519Public());
        expect(pending!.pairing_id).toBe('p1');
      }
    });

    const identity = await runPair({
      // Neither of the two profiles whose names the snippets used to be
      // hard-coded to: a pairing has to print the install line for the profile
      // it actually created, or the owner pastes a command for another agent.
      profile: PROFILE,
      kind: 'other',
      webBase: 'https://zas.red',
      apiBase: 'https://zas.red/api',
      fetch: f.fetchImpl as unknown as typeof fetch,
      sleep,
      log: (line) => logLines.push(line),
      now: () => NOW,
      listen: false,
    });

    const combined = logLines.join('\n');
    expect(combined).toContain(pairUrl('https://zas.red', 'p1'));
    // The pairing announcement itself carries no bare code line; "Add it to
    // Claude Code:" further down the log is a different string that happens
    // to share the substring "Code:", so the check is scoped to that block.
    expect(logLines[0]).not.toContain('Code:');
    expect(combined).toContain('ab12 cd34 ef56 7890');
    expect(combined).toContain('expires in 10 minutes');
    expect(combined).toContain('Done: the agent “Claude Code” is paired with your account.');
    expect(combined).toContain(`claude mcp add zas "--" npx -y zas-agent --profile ${PROFILE}`);
    expect(combined).toContain(`codex mcp add zas "--" npx -y zas-agent --profile ${PROFILE}`);
    expect(combined).not.toContain('[mcp_servers.zas]');
    expect(combined).not.toContain('--profile claude-code');
    expect(combined).toContain('Or to Codex:');

    expect(f.pollHeaders).toEqual(['f'.repeat(64), 'f'.repeat(64), 'f'.repeat(64)]);
    expect(sleepCalls).toEqual([2000, 2000]);
    expect(f.createBodies[0]).toMatchObject({ claim: true });

    expect(identity.agent_uid).toBe(AGENT_UID);
    expect(identity.owner_uid).toBe('owner-1');
    expect(identity.name).toBe('Claude Code');
    expect(loadIdentity(PROFILE)).toEqual(identity);
    expect(loadPending(PROFILE)).toBeNull();
  });

  it('throws pairing_expired and saves no identity when the pairing dies before approval', async () => {
    const f = fakeFetch([{ status: 'expired' }]);
    const logLines: string[] = [];
    await expect(runPair({
      profile: 'claude-code',
      kind: 'claude_code',
      webBase: 'https://zas.red',
      apiBase: 'https://zas.red/api',
      fetch: f.fetchImpl as unknown as typeof fetch,
      sleep: vi.fn(async () => {}),
      log: (line) => logLines.push(line),
      now: () => NOW,
      listen: false,
    })).rejects.toMatchObject({ code: 'pairing_expired' });

    expect(loadIdentity('claude-code')).toBeNull();
    expect(loadPending('claude-code')).toBeNull();
  });

  const oldIdentity = (): Identity => ({
    version: 1, agent_uid: 'agent_' + 'B'.repeat(22), owner_uid: 'owner-0', name: 'Old Agent', kind: 'claude_code',
    host: 'old-box', ...newKeyMaterial(), ...defaultEndpoints(),
  });

  const pairAgain = async (f: ReturnType<typeof fakeFetch>, logLines: string[]) => runPair({
    profile: 'claude-code',
    kind: 'claude_code',
    webBase: 'https://zas.red',
    apiBase: 'https://zas.red/api',
    fetch: f.fetchImpl as unknown as typeof fetch,
    sleep: vi.fn(async () => {}),
    log: (line) => logLines.push(line),
    now: () => NOW,
    listen: false,
  });

  it('opens the pairing as the old agent when the profile is already paired, and says the approval replaces it', async () => {
    const existing = oldIdentity();
    saveIdentity('claude-code', existing);
    const f = fakeFetch([{ status: 'claimed', agent_uid: AGENT_UID, owner_uid: 'owner-1' }], [], 0, { p256Public: existing.p256_public });
    const logLines: string[] = [];
    const identity = await pairAgain(f, logLines);

    // Signed in as the old agent, then the authenticated route, never the public one.
    expect(f.calls).toContain('POST https://zas.red/api/v1/agents/me/pairings');
    expect(f.calls.filter((c) => c.endsWith('/v1/agents/pairings'))).toEqual([]);
    expect(f.replacementAuth).toEqual(['Bearer id-1']);
    expect(f.createBodies[0]).toMatchObject({ kind: 'claude_code', claim: true });
    const said = logLines.filter((l) => l.includes('“Old Agent”'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Approving this pairing replaces that agent');
    expect(logLines.at(-1)).toContain('replaces the previous agent of this profile');
    expect(identity.agent_uid).toBe(AGENT_UID);
    expect(identity.p256_public).not.toBe(existing.p256_public);
    expect(loadIdentity('claude-code')).toEqual(identity);
  });

  it('falls back to an ordinary pairing when the server no longer accepts the old agent, and says so', async () => {
    const existing = oldIdentity();
    saveIdentity('claude-code', existing);
    const f = fakeFetch([{ status: 'claimed', agent_uid: AGENT_UID, owner_uid: 'owner-1' }], [], 0, { p256Public: existing.p256_public, status: 403 });
    const logLines: string[] = [];
    const identity = await pairAgain(f, logLines);

    expect(f.calls).toContain('POST https://zas.red/api/v1/agents/pairings');
    const said = logLines.filter((l) => l.includes('“Old Agent”'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('no longer accepts that agent (agent_revoked)');
    expect(said[0]).toContain('Settings → Agents');
    expect(logLines.at(-1)).not.toContain('replaces the previous agent');
    expect(identity.agent_uid).toBe(AGENT_UID);
    expect(loadIdentity('claude-code')).toEqual(identity);
  });

  it('waits out a rate-limited poll instead of dying, and finishes the pairing', async () => {
    // A pairing lives ten minutes and a first approval takes as long as it
    // takes to find the phone, sign in and pick channels. A 429 in the middle
    // of that is a pause, not the end of the pairing.
    const f = fakeFetch(
      [
        { error: 'rate_limited', retry_after_ms: 25 },
        { status: 'claimed', agent_uid: AGENT_UID, owner_uid: 'owner-1' },
      ],
      [429, 200],
    );
    const sleepCalls: number[] = [];
    const identity = await runPair({
      profile: 'claude-code',
      kind: 'claude_code',
      webBase: 'https://zas.red',
      apiBase: 'https://zas.red/api',
      fetch: f.fetchImpl as unknown as typeof fetch,
      sleep: vi.fn(async (ms: number) => { sleepCalls.push(ms); }),
      log: () => {},
      now: () => NOW,
      listen: false,
    });

    expect(sleepCalls).toEqual([25]);
    expect(identity.agent_uid).toBe(AGENT_UID);
    expect(loadIdentity('claude-code')).toEqual(identity);
  });

  it('falls back to ten seconds when a rate-limited poll names no wait', async () => {
    const f = fakeFetch(
      [{ error: 'rate_limited' }, { status: 'claimed', agent_uid: AGENT_UID, owner_uid: 'owner-1' }],
      [429, 200],
    );
    const sleepCalls: number[] = [];
    await runPair({
      profile: 'claude-code',
      kind: 'claude_code',
      webBase: 'https://zas.red',
      apiBase: 'https://zas.red/api',
      fetch: f.fetchImpl as unknown as typeof fetch,
      sleep: vi.fn(async (ms: number) => { sleepCalls.push(ms); }),
      log: () => {},
      now: () => NOW,
      listen: false,
    });
    expect(sleepCalls).toEqual([10_000]);
  });

  it('stops waiting on a rate limit once the pairing itself has expired', async () => {
    // The pause has the pairing's deadline: past expires_at the server would
    // answer `expired`, so a wall of 429s must not keep the CLI alive forever.
    const f = fakeFetch(
      [{ error: 'rate_limited', retry_after_ms: 25 }, { error: 'rate_limited', retry_after_ms: 25 }],
      [429, 429],
    );
    let clock = NOW;
    await expect(runPair({
      profile: 'claude-code',
      kind: 'claude_code',
      webBase: 'https://zas.red',
      apiBase: 'https://zas.red/api',
      fetch: f.fetchImpl as unknown as typeof fetch,
      sleep: vi.fn(async () => { clock = NOW + 11 * 60 * 1000; }),
      log: () => {},
      now: () => clock,
      listen: false,
    })).rejects.toMatchObject({ code: 'pairing_expired' });
    expect(f.fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/poll')).length).toBe(2);
    expect(loadIdentity('claude-code')).toBeNull();
  });

  it('still stops on an error that is not a rate limit', async () => {
    const f = fakeFetch([{ error: 'not_found' }], [404]);
    await expect(runPair({
      profile: 'claude-code',
      kind: 'claude_code',
      webBase: 'https://zas.red',
      apiBase: 'https://zas.red/api',
      fetch: f.fetchImpl as unknown as typeof fetch,
      sleep: vi.fn(async () => {}),
      log: () => {},
      now: () => NOW,
      listen: false,
    })).rejects.toBeInstanceOf(Error);
    expect(loadIdentity('claude-code')).toBeNull();
  });

  it('builds the pairing URL from the web base and pairing id', () => {
    expect(pairUrl('https://zas.red', 'abc123')).toBe('https://zas.red/agents/pair?p=abc123');
  });

  it('listens on loopback, puts the port in the link, takes the claim from the page and closes', async () => {
    const f = fakeFetch([{ status: 'pending' }]);
    const logLines: string[] = [];
    const run = runPair({ ...baseOpts(f, logLines), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    // The link is printed once the listener is up.
    while (!logLines.join('\n').includes('#port=')) await new Promise((r) => setTimeout(r, 5));
    const port = Number(/#port=(\d+)/.exec(logLines.join('\n'))![1]);
    expect(port).toBeGreaterThan(0);
    expect(loadPending(PROFILE)).toMatchObject({ protocol: 2, port });

    const answer = await fetch(`http://127.0.0.1:${port}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://zas.red' },
      body: JSON.stringify({ pairing_id: 'p1', code: 'ABCDEFGH' }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: 'claimed' });

    const identity = await run;
    expect(identity.agent_uid).toBe(AGENT_UID);
    expect(f.claims).toEqual([{ secret: 'f'.repeat(64), code: 'ABCDEFGH' }]);
    expect(loadPending(PROFILE)).toBeNull();
    expect(logLines.join('\n')).toContain('Done: the agent “Claude Code” is paired with your account.');
    // The listener went with the pairing.
    await expect(fetch(`http://127.0.0.1:${port}/claim`, { method: 'POST' })).rejects.toThrow();
  });

  it('answers a transport failure over loopback as a real HTTP status, then finishes over a typed code', async () => {
    // The claim listener takes exactly one attempt from the page, success or
    // not (`claim-listener.test.ts` pins that), so a transport failure on
    // that one attempt burns the loopback door — the page falls back to
    // showing the code, and the person types the one the pairing already
    // printed. The gate below forces that ordering deterministically: the
    // typed retry cannot reach `claimOnce` until this test's own loopback
    // POST has already been answered, so the fake fetch's claim route sees
    // the failing attempt first and the succeeding one second, never raced.
    const f = fakeFetch([{ status: 'pending' }, { status: 'approved' }], [], 1);
    const logLines: string[] = [];
    let releaseAskCode: () => void = () => {};
    const askCodeGate = new Promise<void>((resolve) => { releaseAskCode = resolve; });
    const askCode = vi.fn(async () => { await askCodeGate; return 'ABCD-EFGH'; });
    const run = runPair({
      ...baseOpts(f, logLines),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      askCode,
    });
    while (!logLines.join('\n').includes('#port=')) await new Promise((r) => setTimeout(r, 5));
    const port = Number(/#port=(\d+)/.exec(logLines.join('\n'))![1]);

    const answer = await fetch(`http://127.0.0.1:${port}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://zas.red' },
      body: JSON.stringify({ pairing_id: 'p1', code: 'ABCDEFGH' }),
    });
    // Before the fix this was HTTP 0: `res.writeHead(0, ...)` throws
    // `RangeError [ERR_HTTP_INVALID_STATUS_CODE]` inside the request handler,
    // an unhandled rejection that kills the CLI without answering the page.
    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({ error: 'network' });

    releaseAskCode();
    const identity = await run;
    expect(identity.agent_uid).toBe(AGENT_UID);
    expect(askCode).toHaveBeenCalled();
    expect(f.claimAttempts()).toBe(2);
    expect(f.claims).toEqual([{ secret: 'f'.repeat(64), code: 'ABCDEFGH' }]);
  });

  it('asks for the code once the poll says approved, asks again on a mismatch, and finishes on the right one', async () => {
    const f = fakeFetch([{ status: 'pending' }, { status: 'approved' }]);
    const logLines: string[] = [];
    const typed = ['ABCD-2345', 'abcd-efgh'];
    const askCode = vi.fn(async () => typed.shift() ?? '');
    const identity = await runPair({ ...baseOpts(f, logLines), sleep: async () => {}, askCode, listen: false });
    expect(askCode).toHaveBeenCalledTimes(2);
    expect(f.claims).toEqual([
      { secret: 'f'.repeat(64), code: 'ABCD2345' },
      { secret: 'f'.repeat(64), code: 'ABCDEFGH' },
    ]);
    expect(logLines.join('\n')).toContain('The code does not match');
    expect(logLines.join('\n')).not.toContain('#port=');
    expect(identity.owner_uid).toBe('owner-1');
  });

  it('says so once when it cannot take a code, and still finishes when the poll says claimed', async () => {
    const f = fakeFetch([{ status: 'approved' }, { status: 'approved' }, { status: 'claimed', agent_uid: AGENT_UID, owner_uid: 'owner-1' }]);
    const logLines: string[] = [];
    await runPair({ ...baseOpts(f, logLines), sleep: async () => {}, listen: false });
    const said = logLines.filter((l) => l.includes('This terminal cannot take a code.'));
    expect(said).toHaveLength(1);
    expect(f.claims).toEqual([]);
  });

  it('opens the link once when asked to, and never otherwise', async () => {
    const f = fakeFetch([{ status: 'claimed', agent_uid: AGENT_UID, owner_uid: 'owner-1' }]);
    const open = vi.fn();
    await runPair({ ...baseOpts(f, []), sleep: async () => {}, listen: false, open });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(pairUrl('https://zas.red', 'p1'));
  });

  it('builds the link with and without a port, and the origin from the web base', () => {
    expect(pairUrl('https://zas.red', 'p1', 53211)).toBe('https://zas.red/agents/pair?p=p1#port=53211');
    expect(pairUrl('https://zas.red', 'p1')).toBe('https://zas.red/agents/pair?p=p1');
    expect(webOriginOf('https://zas.red/')).toBe('https://zas.red');
    expect(webOriginOf('http://localhost:5199/app')).toBe('http://localhost:5199');
  });
});
