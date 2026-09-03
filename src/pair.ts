// The interactive "zas-agent pair" flow: mint fresh key material, hand the
// public halves to the server, open the approval page for the owner, then
// wait until this process claims the pairing. The claim needs two things:
// the poll secret only this process holds, and a claim code the page receives
// at approval. The page hands the code over loopback when it can reach this
// machine; when it cannot, it shows the code and the person types it here.
// Approval alone creates nothing, so a link that reached the wrong person
// creates nothing either. The claim hands back uids, so the first thing this
// does with them is sign in and ask the server who it just became.
import { hostname } from 'node:os';
import {
  AGENT_HOST_MAX, agentFingerprintShort, normalizePairingCode, type AgentKind,
} from './shared/agent.js';
import { startClaimListener, type ClaimListener, type ClaimOutcome } from './claim-listener.js';
import { apiPublic, ZasClient } from './client.js';
import { humanSentence, ZasError } from './errors.js';
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
  /** Asks the person for the code the page shows when the browser could not
   *  reach this process. Absent: this process cannot take a typed code. */
  askCode?: () => Promise<string>;
  /** Opens the link in a browser. Absent: nothing is opened. */
  open?: (url: string) => void;
  /** `false`: no loopback listener, and the link carries no port. */
  listen?: boolean;
}

interface PairingCreated {
  pairing_id: string;
  poll_secret: string;
  expires_at: number;
  fingerprint: string;
}

type PollAnswer =
  | { status: 'pending' | 'expired' | 'cancelled' | 'approved' }
  | { status: 'claimed'; agent_uid: string; owner_uid: string };

interface Claimed {
  agent_uid: string;
  owner_uid: string;
}

const POLL_INTERVAL_MS = 2000;
const NO_TTY_LINE = 'This terminal cannot take a code. If the page shows one, run zas-agent pair again from an interactive terminal.';
const CODE_SHAPE_LINE = 'The code is eight letters and digits, like ABCD-EFGH.';

export function pairUrl(webBase: string, pairingId: string, port?: number): string {
  const link = `${webBase}/agents/pair?p=${pairingId}`;
  // The fragment never reaches the server: the port is for the page alone.
  return port ? `${link}#port=${port}` : link;
}

/** The origin the listener answers: the web base without any path. */
export function webOriginOf(webBase: string): string {
  return new URL(webBase).origin;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that something else resolves, used to cut a poll sleep short. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export async function runPair(opts: PairOptions): Promise<Identity> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  const existing = loadIdentity(opts.profile);
  if (existing) {
    opts.log(
      `This profile is already paired as “${existing.name}”. A new agent will be created; revoke the old one from Settings → Agents.`,
    );
  }

  const host = (opts.host ?? hostname()).slice(0, AGENT_HOST_MAX);
  const keys = newKeyMaterial();
  const endpoints = { ...defaultEndpoints(), api_base: opts.apiBase };

  const created = await apiPublic<PairingCreated>(
    opts.apiBase,
    'POST',
    '/v1/agents/pairings',
    { kind: opts.kind, host, x25519_public: keys.x25519_public, p256_public: keys.p256_public, claim: true },
    {},
    opts.fetch,
  );

  // One claim per pairing, whichever side hands the code over first. A second
  // code that arrives while a claim is in flight waits for that answer
  // rather than racing it; a code after a successful claim is refused here
  // without a request.
  let claimed: Claimed | null = null;
  let inFlight: Promise<ClaimOutcome> | null = null;
  const wake = deferred<void>();
  const claimOnce = (code: string): Promise<ClaimOutcome> => {
    if (claimed) return Promise.resolve({ error: 'pairing_claimed', status: 409 });
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<ClaimOutcome> => {
      try {
        const answer = await apiPublic<Claimed>(
          opts.apiBase,
          'POST',
          `/v1/agents/pairings/${created.pairing_id}/claim`,
          { code },
          { 'X-Zas-Poll-Secret': created.poll_secret },
          opts.fetch,
        );
        claimed = { agent_uid: answer.agent_uid, owner_uid: answer.owner_uid };
        wake.resolve();
        return { status: 'claimed' };
      } catch (err) {
        if (err instanceof ZasError) return { error: err.code, status: err.status };
        // A transport failure (offline, DNS, TLS reset) is not a ZasError, so
        // it has no HTTP status of its own. The loopback listener writes this
        // number straight into `res.writeHead(status, ...)`, so it has to be
        // a real one; the page treats any non-200 answer the same way, by
        // falling back to the code it already shows on screen.
        return { error: 'network', status: 502 };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // The listener comes after the pairing exists: it answers for one pairing
  // id, and that id is the server's to mint. Failing to bind is not a failed
  // pairing — the page shows the code and the person types it.
  let listener: ClaimListener | null = null;
  if (opts.listen !== false) {
    try {
      listener = await startClaimListener({
        webOrigin: webOriginOf(opts.webBase),
        pairingId: created.pairing_id,
        onCode: (code) => claimOnce(normalizePairingCode(code) || code),
      });
    } catch {
      listener = null;
    }
  }
  // Declared before the try: it is read once more after the try/finally ends,
  // to decide whether the pairing failed on the typed-code path.
  let askFailed: unknown = null;

  // The try opens here, before anything that can throw: once the listener is
  // up it holds the event loop open, and a throw from savePending or the poll
  // loop below must still reach the finally that closes it, or the process
  // hangs after printing the error instead of exiting.
  try {
    const port = listener?.port;
    const link = pairUrl(opts.webBase, created.pairing_id, port);

    const pending: Pending = {
      version: 1,
      profile: opts.profile,
      pairing_id: created.pairing_id,
      poll_secret: created.poll_secret,
      fingerprint: created.fingerprint,
      expires_at: created.expires_at,
      kind: opts.kind,
      host,
      ...keys,
      ...endpoints,
      created_at: now(),
      protocol: 2,
      ...(port ? { port } : {}),
    };
    savePending(opts.profile, pending);

    const minutesLeft = Math.max(0, Math.round((created.expires_at - now()) / 60_000));
    opts.log(
      [
        'Open this page signed in to your Zas account:',
        `  ${link}`,
        `Fingerprint: ${agentFingerprintShort(created.fingerprint)}`,
        `Waiting for approval… (expires in ${minutesLeft} minutes)`,
      ].join('\n'),
    );
    opts.open?.(link);

    // The typed path. It starts the first time the poll says approved and no
    // claim has landed, and it runs until a claim lands from either side. A
    // wrong code is one more prompt; anything else ends the pairing.
    let asking = false;
    let toldNoTty = false;
    const askLoop = async (): Promise<void> => {
      try {
        while (!claimed) {
          const code = normalizePairingCode(await opts.askCode!());
          if (!code) { opts.log(CODE_SHAPE_LINE); continue; }
          const outcome = await claimOnce(code);
          if (!('error' in outcome) || outcome.error === 'pairing_claimed') return;
          if (outcome.error === 'claim_mismatch') { opts.log(humanSentence(new ZasError('claim_mismatch', 403))); continue; }
          throw new ZasError(outcome.error, outcome.status);
        }
      } catch (e) {
        askFailed = e;
        wake.resolve();
      }
    };

    for (;;) {
      if (claimed) break;
      if (askFailed) throw askFailed;
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
        // page is still open, and the person is still walking to their phone.
        // Anything else is a real failure.
        if (!(err instanceof ZasError) || err.code !== 'rate_limited') throw err;
        // A pause has the same deadline as the pairing itself: past expires_at
        // the server would answer `expired`, so stop asking.
        if (now() >= created.expires_at) throw new ZasError('pairing_expired', 410);
        await Promise.race([sleep(err.retryAfterMs ?? 10_000), wake.promise]);
        continue;
      }
      if (claimed) break;
      if (answer.status === 'claimed') {
        claimed = { agent_uid: answer.agent_uid, owner_uid: answer.owner_uid };
        break;
      }
      if (answer.status === 'expired' || answer.status === 'cancelled') {
        clearPending(opts.profile);
        throw new ZasError(`pairing_${answer.status}`, 410);
      }
      if (answer.status === 'approved') {
        if (opts.askCode && !asking) { asking = true; void askLoop(); }
        if (!opts.askCode && !toldNoTty) { toldNoTty = true; opts.log(NO_TTY_LINE); }
      }
      await Promise.race([sleep(POLL_INTERVAL_MS), wake.promise]);
    }
  } finally {
    await listener?.close();
  }
  if (askFailed) throw askFailed;
  if (!claimed) throw new ZasError('pairing_expired', 410);

  const baseIdentity: Identity = {
    version: 1,
    agent_uid: claimed.agent_uid,
    owner_uid: claimed.owner_uid,
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
    ? claudeLines('Add it to Claude Code:')
    : opts.kind === 'codex'
      ? codexLines('Add it to Codex:')
      // An agent of any other kind speaks one of the two configurations, and
      // this side cannot tell which: both, and the owner picks.
      : [...claudeLines('Add it to Claude Code:'), ...codexLines('Or to Codex:')];
  opts.log(
    [
      `Done: the agent “${identity.name}” is paired with your account.`,
      ...install,
    ].join('\n'),
  );

  return identity;
}
