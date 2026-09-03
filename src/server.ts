// The MCP surface: seven tools, and nothing behind them that the CLI could not
// also call. Everything a coding agent is allowed to do with a Zas account
// passes through here, so two rules hold for every tool in the file. It answers
// in the closed error vocabulary — `code: <es> / <en>` — and never with a stack
// trace or a raw server word. And a send is a job, not a call: the work starts,
// the caller waits a minute for it, and what comes back after that is an id to
// ask about later rather than a timeout.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { normalizePairingCode } from './shared/agent.js';
import { ZasClient } from './client.js';
import { humanSentence, ZasError } from './errors.js';
import { channelNameOf, grantsFor } from './grants.js';
import { defaultEndpoints, loadIdentity, type Identity, type RemoteGrant } from './identity.js';
import { JobRunner } from './jobs.js';
import { openInBrowser } from './open.js';
import { runPair } from './pair.js';
import { getItem, listItems } from './read.js';
import { sendFile, sendNote, type SendContext } from './send.js';
import { kindForProfile, packageName, pairSnippet } from './snippets.js';

export interface ServerDeps {
  identity?: Identity;
  client?: ZasClient;
  runner?: JobRunner;
  /** Injected so `zas_pair`'s four states — announcing, pending, paired,
   *  failed-then-retryable — can be driven offline. */
  runPair?: typeof runPair;
  announceMs?: number;
}

/** The version esbuild bakes in (see `build.mjs`). Absent under vitest and
 *  under a bare `tsc`, where nothing defined it — the fallback says so out
 *  loud rather than claiming a release number this build is not. */
export function agentVersion(): string {
  return typeof __ZAS_AGENT_VERSION__ === 'string' ? __ZAS_AGENT_VERSION__ : '0.0.0-dev';
}

/** The clause every tool description ends with. A model reads these before it
 *  decides to call anything, and the one thing it must know about this account
 *  is that nothing here is quiet: every item carries the agent mark and the
 *  agent's name wherever the owner reads it. Written in the language of the
 *  descriptions themselves, which are English for the model. */
const AGENT_CUE = " The owner sees every item this agent sends with the >_ agent mark and this agent's name, on every device.";

/** How long the first `zas_pair` call waits for the pairing block before it
 *  answers anyway. The block is one POST away; anything slower is a network
 *  the caller should hear about rather than a call that hangs. */
const PAIR_ANNOUNCE_MS = 15_000;

const NOTE_LABEL_MAX = 40;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

interface Pairing {
  logs: string[];
  status: 'running' | 'paired' | 'failed';
  identity?: Identity;
  error?: unknown;
  /** Set while runPair is waiting for a typed code; the next call with `code` answers it. */
  ask: ((code: string) => void) | null;
}

/** What the agent may do with one channel.
 *  `view` is a permission on the channel and outranks the grant's own `send`,
 *  so a channel the owner switched to view-only never claims it can send. A
 *  channel in Directo mode is the same story: `send.ts` refuses every send to
 *  one with `direct_mode`, so this line must not promise otherwise. */
function rightsOf(grant: RemoteGrant): string {
  const rights: string[] = [];
  if (grant.send && grant.mode !== 'view' && !grant.direct_mode) rights.push('send');
  if (grant.read) rights.push('read');
  return rights.length > 0 ? rights.join(' · ') : 'no access';
}

export function buildServer(profile: string, deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'zas', version: agentVersion() });
  const runner = deps.runner ?? new JobRunner();

  // One session per identity. A fresh `ZasClient` on every tool call would
  // sign in again each time — a challenge and a token per call, out of the
  // thirty an agent gets in an hour — and every call would pay three round
  // trips before it started.
  let client: ZasClient | null = null;
  const ctx = (): SendContext => {
    const identity = deps.identity ?? loadIdentity(profile);
    if (!identity) throw new ZasError('not_paired', 0);
    if (deps.client) return { identity, client: deps.client, profile };
    if (!client || client.identity.agent_uid !== identity.agent_uid) client = new ZasClient(identity);
    return { identity, client, profile };
  };

  const text = (value: unknown) => ({
    content: [{
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  });

  const notPairedSentence = () =>
    `This agent is not paired yet. Run “${pairSnippet(profile)}” in the terminal.`;

  const failed = (e: unknown) => {
    const err = e instanceof ZasError ? e : new ZasError('internal', 0, String(e));
    const sentence = err.code === 'not_paired' ? notPairedSentence() : humanSentence(err);
    return { isError: true, ...text(`${err.code}: ${sentence}`) };
  };

  /** A job's own answer. `done` hands back the result; `failed` is reported the
   *  same way a thrown `ZasError` would be, because the caller cannot tell the
   *  two apart and must not have to; still running is an id and a phase. */
  const settled = (job: ReturnType<JobRunner['start']>) => {
    if (job.status === 'done') return text(job.result);
    if (job.status === 'failed') {
      // Rebuilt whole, not by code alone: the sentence for `identity_corrupt`
      // interpolates the path out of the message, and a `rate_limited` job
      // that lost `retry_after_ms` cannot say how long to wait.
      const e = job.error;
      return failed(e
        ? new ZasError(e.code, e.status, e.message, e.retryAfterMs, e.serverCode)
        : new ZasError('internal', 0));
    }
    return text({ job_id: job.id, status: 'running', phase: job.phase });
  };

  // ---- status ----

  server.registerTool('zas_status', {
    description: "Say whether this machine is paired with a Zas account, and list the owner's channels this agent may send to or read from." + AGENT_CUE,
  }, async () => {
    try {
      // Deliberately not an error when the profile is unpaired: "am I set up?"
      // is a question, and the answer to it is not a failure. A damaged
      // identity file is a different thing and still reaches `failed` below.
      if (!(deps.identity ?? loadIdentity(profile))) {
        return text(notPairedSentence());
      }
      const c = ctx();
      const grants = await grantsFor(c.client, profile);
      const lines = grants.map((grant) => {
        // A channel whose name will not open is still a channel this agent
        // holds. Its id is a worse label than its name and a much better one
        // than dropping the row, which would read as "the owner took it away".
        let name = grant.channel_id;
        try {
          name = channelNameOf(c.identity, grant);
        } catch { /* the id stands in */ }
        return `  ${name} · ${rightsOf(grant)}`;
      });
      return text([
        `Paired as “${c.identity.name}” (${c.identity.kind}) with account ${c.identity.owner_uid}.`,
        grants.length > 0 ? 'Channels:' : 'No channels: the owner has not granted access to any yet.',
        ...lines,
        `${packageName()} ${agentVersion()} · profile ${profile}`,
      ].join('\n'));
    } catch (e) {
      return failed(e);
    }
  });

  // ---- pairing ----

  let pairing: Pairing | null = null;

  server.registerTool('zas_pair', {
    description: 'Pair this machine with a Zas account. The first call returns a URL for the owner to open; a later call says whether they approved. If the page shows a code, call again with `code`.' + AGENT_CUE,
    inputSchema: {
      code: z.string().optional().describe('The code the pairing page shows when the browser could not reach this machine.'),
    },
  }, async (input) => {
    if (!pairing) {
      if (input.code !== undefined) return failed(new ZasError('pairing_not_approved', 409));
      const state: Pairing = { logs: [], status: 'running', ask: null };
      pairing = state;
      // The promise is settled onto the state and never rethrown: an
      // unobserved rejection would take the whole MCP server down while the
      // owner was still looking at the pairing page.
      (deps.runPair ?? runPair)({
        profile,
        kind: kindForProfile(profile),
        webBase: process.env.ZAS_WEB_BASE || 'https://zas.red',
        // Read now, not at import: an MCP server is started by a client that
        // may have set the environment after this module was loaded.
        apiBase: defaultEndpoints().api_base,
        log: (line) => { state.logs.push(line); },
        // The person cannot type into this process; the coding agent relays
        // the code as an argument, and this promise is what it answers.
        askCode: () => new Promise<string>((resolve) => { state.ask = resolve; }),
        ...(process.env.ZAS_NO_OPEN === '1' ? {} : { open: openInBrowser }),
      }).then(
        (identity) => { state.status = 'paired'; state.identity = identity; },
        (error: unknown) => { state.status = 'failed'; state.error = error; },
      );
      const until = Date.now() + (deps.announceMs ?? PAIR_ANNOUNCE_MS);
      while (state.status === 'running' && !state.logs.some(hasPairUrl) && Date.now() < until) {
        await delay(50);
      }
      if (state.status === 'failed') {
        pairing = null;
        return failed(state.error);
      }
      return text(state.logs.join('\n') || 'Opening the pairing…');
    }
    if (pairing.status === 'paired') return text(`paired as ${pairing.identity?.name ?? ''}`.trim());
    if (pairing.status === 'failed') {
      // Reported once, then forgotten: an expired pairing or a network that
      // came back must be retryable from the same tool, and a state that only
      // ever holds the first failure would make the tool useless after one.
      const error = pairing.error;
      pairing = null;
      return failed(error);
    }
    if (input.code !== undefined) {
      const state = pairing;
      const ask = state.ask;
      // No open question means the owner has not approved yet, or a claim is
      // already in flight: either way there is nothing to answer with.
      if (!ask) return failed(new ZasError('pairing_not_approved', 409));
      state.ask = null;
      ask(normalizePairingCode(input.code) || input.code);
      // The claim is one request away. Wait for it to settle: paired, failed,
      // or asked again — which is what a mismatch looks like from here.
      const until = Date.now() + (deps.announceMs ?? PAIR_ANNOUNCE_MS);
      while (state.status === 'running' && state.ask === null && Date.now() < until) {
        await delay(10);
      }
      if (state.status === 'paired') return text(`paired as ${state.identity?.name ?? ''}`.trim());
      if (state.status === 'failed') {
        const error = state.error;
        pairing = null;
        return failed(error);
      }
      if (state.ask !== null) return failed(new ZasError('claim_mismatch', 403));
      return text(['pending', ...state.logs].join('\n'));
    }
    return text(['pending', ...pairing.logs].join('\n'));
  });

  // ---- sending ----

  server.registerTool('zas_send_file', {
    description: "Send a file from this machine into one of the owner's Zas channels. Returns the item id, or a job id when the upload takes longer than a minute. Sends any file this process can read; confirm with the owner before sending secrets, keys or credentials." + AGENT_CUE,
    inputSchema: {
      path: z.string().describe('Absolute or relative path of the file to send.'),
      channel: z.string().optional().describe('Channel name or id. Optional when the agent holds exactly one channel.'),
      title: z.string().optional().describe('Label for the item. Defaults to the file name.'),
    },
  }, async (input) => {
    try {
      const c = ctx();
      const job = runner.start(
        'file', input.title ?? input.path, input.channel ?? '',
        (report) => sendFile(c, input, report),
      );
      return settled(await runner.wait(job));
    } catch (e) {
      return failed(e);
    }
  });

  server.registerTool('zas_send_note', {
    description: "Send a note — plain text, or a code snippet with its language — into one of the owner's Zas channels." + AGENT_CUE,
    inputSchema: {
      text: z.string().describe('The body of the note.'),
      channel: z.string().optional().describe('Channel name or id. Optional when the agent holds exactly one channel.'),
      title: z.string().optional().describe('Label for the item. Defaults to the first line.'),
      lang: z.string().optional().describe('Language of the snippet, for highlighting (for example "ts", "py").'),
      secret: z.boolean().optional().describe('Hide the body behind a cover until the reader opens it.'),
    },
  }, async (input) => {
    try {
      const c = ctx();
      const job = runner.start(
        'note', input.title ?? input.text.split('\n', 1)[0].slice(0, NOTE_LABEL_MAX), input.channel ?? '',
        () => sendNote(c, input),
      );
      return settled(await runner.wait(job));
    } catch (e) {
      return failed(e);
    }
  });

  // ---- reading ----

  server.registerTool('zas_list_items', {
    description: "List the most recent items in one of the owner's Zas channels. Needs a grant that includes reading." + AGENT_CUE,
    inputSchema: {
      channel: z.string().describe('Channel name or id.'),
      limit: z.number().int().min(1).max(50).optional()
        .describe('How many items, 1 to 50. Defaults to 20.'),
    },
  }, async (input) => {
    try {
      return text(await listItems(ctx(), input.channel, input.limit));
    } catch (e) {
      return failed(e);
    }
  });

  server.registerTool('zas_get_item', {
    description: 'Fetch one item from a Zas channel. A note comes back as text; a file is written to disk. Returns the path written; it can differ from `dest` when a file with that name already exists. Writes a new file under `dest` (or the system temp directory); it never overwrites an existing file.' + AGENT_CUE,
    inputSchema: {
      channel: z.string().describe('Channel name or id.'),
      id: z.string().describe('Item id, as `zas_list_items` reports it.'),
      dest: z.string().optional().describe('Where to write a file. A directory means "inside it". Defaults to a fresh temporary directory.'),
    },
  }, async (input) => {
    try {
      return text(await getItem(ctx(), input.channel, input.id, input.dest));
    } catch (e) {
      return failed(e);
    }
  });

  // ---- jobs ----

  server.registerTool('zas_jobs', {
    description: 'List the sends this server started, newest first, with the phase each one reached and how it ended — including any `job_id` a send returned; a finished job keeps its result here.' + AGENT_CUE,
  }, async () => text(runner.list()));

  return server;
}

const hasPairUrl = (line: string): boolean => line.includes('/agents/pair?p=');
