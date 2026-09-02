// The interactive "zas-agent pair" flow: mint fresh key material, hand the
// public halves to the server, show the owner a URL/code/fingerprint to
// approve from their phone or browser, then poll until they do. Approval only
// hands back uids, so the first thing this does with them is sign in and ask
// the server who it just became.
import { hostname } from 'node:os';
import { AGENT_HOST_MAX, agentFingerprintShort, type AgentKind } from './shared/agent.js';
import { apiPublic, ZasClient } from './client.js';
import { ZasError } from './errors.js';
import { claudeSnippet, codexSnippet } from './snippets.js';
import {
  clearPending, defaultEndpoints, loadIdentity, newKeyMaterial, saveIdentity, savePending,
  type Identity, type Pending,
} from './identity.js';

export interface PairOptions {
  profile: string;
  kind: AgentKind;
  /** Defaults to os.hostname(), truncated to AGENT_HOST_MAX. */
  host?: string;
  webBase: string;
  apiBase: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now?: () => number;
}

interface PairingCreated {
  pairing_id: string;
  code: string;
  poll_secret: string;
  expires_at: number;
  fingerprint: string;
}

type PollAnswer =
  | { status: 'pending' | 'expired' | 'cancelled' }
  | { status: 'approved'; agent_uid: string; owner_uid: string };

const POLL_INTERVAL_MS = 2000;

export function pairUrl(webBase: string, pairingId: string): string {
  return `${webBase}/agents/pair?p=${pairingId}`;
}

function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runPair(opts: PairOptions): Promise<Identity> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  const existing = loadIdentity(opts.profile);
  if (existing) {
    opts.log(
      `Este perfil ya está emparejado como «${existing.name}». Se va a crear un agente nuevo; revocá el anterior desde Ajustes → Agentes.`,
    );
  }

  const host = (opts.host ?? hostname()).slice(0, AGENT_HOST_MAX);
  const keys = newKeyMaterial();
  const endpoints = { ...defaultEndpoints(), api_base: opts.apiBase };

  const created = await apiPublic<PairingCreated>(
    opts.apiBase,
    'POST',
    '/v1/agents/pairings',
    { kind: opts.kind, host, x25519_public: keys.x25519_public, p256_public: keys.p256_public },
    {},
    opts.fetch,
  );

  const pending: Pending = {
    version: 1,
    profile: opts.profile,
    pairing_id: created.pairing_id,
    poll_secret: created.poll_secret,
    code: created.code,
    fingerprint: created.fingerprint,
    expires_at: created.expires_at,
    kind: opts.kind,
    host,
    ...keys,
    ...endpoints,
    created_at: now(),
  };
  savePending(opts.profile, pending);

  const minutesLeft = Math.max(0, Math.round((created.expires_at - now()) / 60_000));
  opts.log(
    [
      'Abrí esta página con tu cuenta de Zas:',
      `  ${pairUrl(opts.webBase, created.pairing_id)}`,
      `Código:  ${formatCode(created.code)}`,
      `Huella:  ${agentFingerprintShort(created.fingerprint)}`,
      `Esperando la aprobación… (vence en ${minutesLeft} minutos)`,
    ].join('\n'),
  );

  let approved: { agent_uid: string; owner_uid: string } | null = null;
  for (;;) {
    let answer: PollAnswer;
    try {
      answer = await apiPublic<PollAnswer>(
        opts.apiBase,
        'POST',
        `/v1/agents/pairings/${created.pairing_id}/poll`,
        undefined,
        { 'X-Zas-Poll-Secret': created.poll_secret },
        opts.fetch,
      );
    } catch (err) {
      // A rate limit on the poll is a pause, not the end of the pairing: the
      // code on screen is good for ten minutes, and the person is still
      // walking to their phone. Anything else is a real failure.
      if (!(err instanceof ZasError) || err.code !== 'rate_limited') throw err;
      // A pause has the same deadline as the pairing itself: past expires_at
      // the server would answer `expired`, so stop asking.
      if (now() >= created.expires_at) throw new ZasError('pairing_expired', 410);
      await sleep(err.retryAfterMs ?? 10_000);
      continue;
    }
    if (answer.status === 'approved') {
      approved = { agent_uid: answer.agent_uid, owner_uid: answer.owner_uid };
      break;
    }
    if (answer.status === 'expired' || answer.status === 'cancelled') {
      clearPending(opts.profile);
      throw new ZasError(`pairing_${answer.status}`, 410);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const baseIdentity: Identity = {
    version: 1,
    agent_uid: approved.agent_uid,
    owner_uid: approved.owner_uid,
    name: '',
    kind: opts.kind,
    host,
    ...keys,
    ...endpoints,
  };

  const client = new ZasClient(baseIdentity, { fetch: opts.fetch, now });
  await client.signIn();
  const me = await client.api<{ name: string }>('GET', '/agents/me');

  const identity: Identity = { ...baseIdentity, name: me.name };
  saveIdentity(opts.profile, identity);
  clearPending(opts.profile);

  // The snippet has to name the profile this pairing actually created, and the
  // agent it was created for: printing `--profile claude-code` to someone who
  // typed `--profile trabajo` hands them a command for a different identity.
  const claudeLines = (lead: string): string[] => [lead, `  ${claudeSnippet(opts.profile)}`];
  const codexLines = (lead: string): string[] => [lead, `  ${codexSnippet(opts.profile)}`];
  const install = opts.kind === 'claude_code'
    ? claudeLines('Agregalo a Claude Code:')
    : opts.kind === 'codex'
      ? codexLines('Agregalo a Codex:')
      // An agent of any other kind speaks one of the two configurations, and
      // this side cannot tell which: both, and the owner picks.
      : [...claudeLines('Agregalo a Claude Code:'), ...codexLines('O a Codex:')];
  opts.log(
    [
      `Listo: el agente «${identity.name}» quedó emparejado con tu cuenta.`,
      ...install,
    ].join('\n'),
  );

  return identity;
}
