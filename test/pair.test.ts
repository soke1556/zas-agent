import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairUrl, runPair } from '../src/pair.js';
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
function fakeFetch(pollAnswers: Array<Record<string, unknown>>, pollStatuses: number[] = []) {
  const calls: string[] = [];
  const pollHeaders: string[] = [];
  let capturedP256Public = '';
  let capturedX25519Public = '';
  let pollIndex = 0;
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.endsWith('/v1/agents/pairings')) {
      capturedP256Public = String(body.p256_public);
      capturedX25519Public = String(body.x25519_public);
      return json(201, {
        pairing_id: 'p1',
        code: 'ABCDEFGH',
        poll_secret: 'f'.repeat(64),
        expires_at: NOW + 10 * 60 * 1000,
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
    if (url.endsWith('/v1/agents/challenge')) {
      return json(200, { challenge_id: 'ch1', nonce: Buffer.alloc(32, 3).toString('base64') });
    }
    if (url.endsWith('/v1/agents/token')) {
      const ok = verifyAgentChallenge(
        b64ToBytes(capturedP256Public),
        b64ToBytes(String(body.signature)),
        String(body.agent_uid),
        String(body.challenge_id),
        Buffer.alloc(32, 3),
      );
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

  return { fetchImpl, calls, pollHeaders, x25519Public: () => capturedX25519Public };
}

describe('runPair', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'zas-agent-pair-')); process.env.ZAS_AGENT_HOME = home; });
  afterEach(() => { delete process.env.ZAS_AGENT_HOME; rmSync(home, { recursive: true, force: true }); });

  it('prints the pairing block, keeps a pending file until approval, then saves the identity', async () => {
    const f = fakeFetch([{ status: 'pending' }, { status: 'pending' }, { status: 'approved', agent_uid: AGENT_UID, owner_uid: 'owner-1' }]);
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
    });

    const combined = logLines.join('\n');
    expect(combined).toContain(pairUrl('https://zas.red', 'p1'));
    expect(combined).toContain('ABCD-EFGH');
    expect(combined).toContain('ab12 cd34 ef56 7890');
    expect(combined).toContain('vence en 10 minutos');
    expect(combined).toContain('Listo: el agente «Claude Code» quedó emparejado con tu cuenta.');
    expect(combined).toContain(`claude mcp add zas -- npx -y zas-agent --profile ${PROFILE}`);
    expect(combined).toContain(`codex mcp add zas -- npx -y zas-agent --profile ${PROFILE}`);
    expect(combined).not.toContain('[mcp_servers.zas]');
    expect(combined).not.toContain('--profile claude-code');
    expect(combined).toContain('O a Codex:');

    expect(f.pollHeaders).toEqual(['f'.repeat(64), 'f'.repeat(64), 'f'.repeat(64)]);
    expect(sleepCalls).toEqual([2000, 2000]);

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
    })).rejects.toMatchObject({ code: 'pairing_expired' });

    expect(loadIdentity('claude-code')).toBeNull();
    expect(loadPending('claude-code')).toBeNull();
  });

  it('warns once and continues when the profile is already paired', async () => {
    const existing: Identity = {
      version: 1, agent_uid: 'agent_' + 'B'.repeat(22), owner_uid: 'owner-0', name: 'Old Agent', kind: 'claude_code',
      host: 'old-box', ...newKeyMaterial(), ...defaultEndpoints(),
    };
    saveIdentity('claude-code', existing);

    const f = fakeFetch([{ status: 'approved', agent_uid: AGENT_UID, owner_uid: 'owner-1' }]);
    const logLines: string[] = [];
    const identity = await runPair({
      profile: 'claude-code',
      kind: 'claude_code',
      webBase: 'https://zas.red',
      apiBase: 'https://zas.red/api',
      fetch: f.fetchImpl as unknown as typeof fetch,
      sleep: vi.fn(async () => {}),
      log: (line) => logLines.push(line),
      now: () => NOW,
    });

    const warnLines = logLines.filter((l) => l.includes('ya está emparejado'));
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toContain('«Old Agent»');
    expect(warnLines[0]).toContain('Ajustes → Agentes');
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
        { status: 'approved', agent_uid: AGENT_UID, owner_uid: 'owner-1' },
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
    });

    expect(sleepCalls).toEqual([25]);
    expect(identity.agent_uid).toBe(AGENT_UID);
    expect(loadIdentity('claude-code')).toEqual(identity);
  });

  it('falls back to ten seconds when a rate-limited poll names no wait', async () => {
    const f = fakeFetch(
      [{ error: 'rate_limited' }, { status: 'approved', agent_uid: AGENT_UID, owner_uid: 'owner-1' }],
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
    })).rejects.toBeInstanceOf(Error);
    expect(loadIdentity('claude-code')).toBeNull();
  });

  it('builds the pairing URL from the web base and pairing id', () => {
    expect(pairUrl('https://zas.red', 'abc123')).toBe('https://zas.red/agents/pair?p=abc123');
  });
});
