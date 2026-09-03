// What the MCP surface answers when nothing is on the other end of the wire.
// The end-to-end file proves the tools against real servers; this one proves
// the three answers that have nothing to do with the network — an unpaired
// profile, a refusal, and the argument parsing behind the executable — so the
// offline half of CI still covers `server.ts` and `cli.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A test must never open the person's real browser: `zas_pair` calls
// `openInBrowser` for real unless this module is mocked out.
vi.mock('../src/open.js', () => ({ openInBrowser: vi.fn() }));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { b64ToBytes, bytesToB64 } from '../src/shared/hash.js';
import { encryptChannelName } from '../src/shared/manifest.js';
import { assignChannelKey, mintChannelKey } from '../src/shared/sharedchannel.js';
import type { ZasClient } from '../src/client.js';
import { humanSentence, ZasError } from '../src/errors.js';
import { defaultEndpoints, newKeyMaterial, type Identity, type RemoteGrant } from '../src/identity.js';
import { JobRunner } from '../src/jobs.js';
import { openInBrowser } from '../src/open.js';
import type { runPair } from '../src/pair.js';
import type { SendResult } from '../src/send.js';
import { agentVersion, buildServer } from '../src/server.js';
import { parseArgs } from '../src/cli.js';

const keys = newKeyMaterial();
const identity: Identity = {
  version: 1,
  agent_uid: `agent_${'A'.repeat(22)}`,
  owner_uid: 'owner-1',
  name: 'Claude Code',
  kind: 'claude_code',
  host: 'box',
  ...keys,
  ...defaultEndpoints(),
};

const workKey = mintChannelKey();
const draftKey = mintChannelKey();

function grant(channelId: string, key: Uint8Array, name: string, read: boolean): RemoteGrant {
  return {
    channel_id: channelId,
    send: true,
    read,
    wrapped_key: bytesToB64(assignChannelKey(b64ToBytes(keys.x25519_public), 1, key)),
    key_version: 1,
    name_enc: bytesToB64(encryptChannelName(key, name, 1)),
    mode: 'edit',
    direct_mode: false,
  };
}

function fakeClient(api: (method: string, path: string) => Promise<unknown>): ZasClient {
  return { identity, api: vi.fn(api) } as unknown as ZasClient;
}

const PAIR_BLOCK = [
  'Open this page signed in to your Zas account:',
  '  https://zas.red/agents/pair?p=p1#port=53211',
  'Fingerprint: 1a2b 3c4d 5e6f 7a8b',
  'Waiting for approval… (expires in 10 minutes)',
].join('\n');

/** A `runPair` the test settles by hand. It logs the pairing block the moment
 *  it is called — as the real one does, one POST in — so the tool's announce
 *  loop has something to answer with, and then hangs until the test decides. */
function fakePair() {
  let settle: { resolve: (value: Identity) => void; reject: (error: unknown) => void } | null = null;
  let started = 0;
  let opts: Parameters<typeof runPair>[0] | null = null;
  const impl = ((o: Parameters<typeof runPair>[0]) => {
    started += 1;
    opts = o;
    o.log(PAIR_BLOCK);
    o.open?.('https://zas.red/agents/pair?p=p1#port=53211');
    return new Promise<Identity>((resolve, reject) => { settle = { resolve, reject }; });
  }) as typeof runPair;
  return {
    impl,
    started: () => started,
    /** What runPair does when the poll says approved: ask, and wait. */
    askCode: () => opts!.askCode!(),
    opened: () => opts?.open !== undefined,
    resolve: (value: Identity) => { settle!.resolve(value); },
    reject: (error: unknown) => { settle!.reject(error); },
  };
}

/** Long enough for a settled promise's callbacks to have run. */
const settleTick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });

async function connect(server: ReturnType<typeof buildServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unit', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }) as unknown as {
    content?: { text?: string }[];
    isError?: boolean;
  };
  return {
    text: (result.content ?? []).map((part) => part.text ?? '').join('\n'),
    isError: result.isError === true,
  };
}

describe('buildServer', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-agent-server-'));
    process.env.ZAS_AGENT_HOME = home;
  });

  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('tells the model, in every tool description, that the owner sees the agent mark', async () => {
    // The descriptions are the only thing an LLM reads before it decides to
    // send. Every one of them says the send is visible and attributed, so the
    // model cannot treat a Zas channel as a quiet place to put something.
    const client = await connect(buildServer('nobody'));
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(7);
    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).toContain('>_');
      expect(tool.description ?? '', tool.name).toMatch(/name/);
    }
    await client.close();
  });

  it('answers an unpaired profile with the sentence, not an error', async () => {
    const client = await connect(buildServer('nobody'));
    const status = await call(client, 'zas_status');
    expect(status.isError).toBe(false);
    expect(status.text).toContain('zas-agent pair');
    expect(status.text).not.toContain('not_paired');
    await client.close();
  });

  it('lists every grant with what it may do, and names the build', async () => {
    const grants = [grant('c1', workKey, 'Trabajo', true), grant('c2', draftKey, 'Borradores', false)];
    const client = await connect(buildServer('p', {
      identity,
      client: fakeClient(async () => ({ grants })),
    }));
    const status = await call(client, 'zas_status');
    expect(status.isError).toBe(false);
    expect(status.text).toContain('“Claude Code”');
    expect(status.text).toContain('owner-1');
    expect(status.text).toContain('Trabajo · send · read');
    expect(status.text).toContain('Borradores · send');
    expect(status.text).toContain(agentVersion());
    await client.close();
  });

  it('reports a channel it cannot name by its id rather than dropping it', async () => {
    // Sealed under a key this agent was never given: the row is still a channel
    // it holds, and hiding it would read as "the owner took it away".
    const stranger = { ...grant('c9', workKey, 'Ajena', true), name_enc: bytesToB64(new Uint8Array(24)) };
    const client = await connect(buildServer('p', {
      identity,
      client: fakeClient(async () => ({ grants: [stranger] })),
    }));
    const status = await call(client, 'zas_status');
    expect(status.text).toContain('c9 · send · read');
    await client.close();
  });

  it('turns a refusal into the closed code and its sentence', async () => {
    const client = await connect(buildServer('p', {
      identity,
      client: fakeClient(async () => { throw new ZasError('agent_revoked', 403); }),
    }));
    const refused = await call(client, 'zas_send_note', { text: 'hola', channel: 'Trabajo' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('agent_revoked');
    expect(refused.text).toContain('The owner revoked this agent');
    await client.close();
  });

  it('refuses every tool that needs an identity when the profile has none', async () => {
    const client = await connect(buildServer('nobody'));
    for (const name of ['zas_send_file', 'zas_send_note', 'zas_list_items', 'zas_get_item']) {
      const refused = await call(client, name, {
        path: 'x', text: 'x', channel: 'c1', id: 'abc',
      });
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain('not_paired');
    }
    await client.close();
  });

  it('never claims a Directo channel can be sent to', async () => {
    // `send.ts` refuses every send to a channel in Directo mode, so a status
    // line that says “send” is the one place the package disagrees with
    // itself. Reading stays true: Directo changes nothing about it.
    const grants = [
      { ...grant('c3', workKey, 'Directo', true), direct_mode: true },
      { ...grant('c4', draftKey, 'Silencio', false), direct_mode: true },
    ];
    const client = await connect(buildServer('p', {
      identity,
      client: fakeClient(async () => ({ grants })),
    }));
    const status = await call(client, 'zas_status');
    expect(status.text).toContain('Directo · read');
    expect(status.text).not.toContain('Directo · send');
    expect(status.text).toContain('Silencio · no access');
    expect(status.text).not.toContain('Silencio · send');
    await client.close();
  });

  it('answers a failed job with the sentence its own error renders', async () => {
    const error = new ZasError('rate_limited', 429, undefined, 30_000);
    const runner = new JobRunner();
    const client = await connect(buildServer('p', {
      identity,
      runner,
      client: fakeClient(async () => { throw error; }),
    }));
    const refused = await call(client, 'zas_send_note', { text: 'hola', channel: 'Trabajo' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(
      `rate_limited: ${humanSentence(error)}`,
    );
    // The retry hint survives on the job too, so `zas_jobs` can still say how
    // long the caller was asked to wait.
    const jobs = JSON.parse((await call(client, 'zas_jobs')).text) as { error?: Record<string, unknown> }[];
    expect(jobs[0].error).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 30_000 });
    await client.close();
  });

  it('keeps the message a failed job’s sentence interpolates', async () => {
    const path = join('tmp', 'p', 'identity.json');
    const client = await connect(buildServer('p', {
      identity,
      client: fakeClient(async () => { throw new ZasError('identity_corrupt', 0, path); }),
    }));
    const refused = await call(client, 'zas_send_note', { text: 'hola', channel: 'Trabajo' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(path);
    expect(refused.text).not.toContain('{path}');
    await client.close();
  });

  describe('zas_pair', () => {
    it('hands back the pairing block on the first call and pending on the second', async () => {
      const pair = fakePair();
      const client = await connect(buildServer('p', { runPair: pair.impl, announceMs: 10 }));

      const first = await call(client, 'zas_pair');
      expect(first.isError).toBe(false);
      expect(first.text).toContain('/agents/pair?p=p1');
      expect(first.text).not.toContain('Code:');
      expect(first.text).toContain('Waiting for approval');

      const second = await call(client, 'zas_pair');
      expect(second.text).toContain('pending');
      expect(second.text).toContain('/agents/pair?p=p1');
      expect(pair.started()).toBe(1);
      await client.close();
    });

    it('reports the pairing once it lands, and stays there', async () => {
      const pair = fakePair();
      const client = await connect(buildServer('p', { runPair: pair.impl, announceMs: 10 }));
      await call(client, 'zas_pair');

      pair.resolve({ ...identity, name: 'Claude Code' });
      await settleTick();

      expect((await call(client, 'zas_pair')).text).toBe('paired as Claude Code');
      expect((await call(client, 'zas_pair')).text).toBe('paired as Claude Code');
      expect(pair.started()).toBe(1);
      await client.close();
    });

    it('reports a failure once and lets the next call start over', async () => {
      const pair = fakePair();
      const client = await connect(buildServer('p', { runPair: pair.impl, announceMs: 10 }));
      await call(client, 'zas_pair');

      pair.reject(new ZasError('pairing_expired', 410));
      await settleTick();

      const failed = await call(client, 'zas_pair');
      expect(failed.isError).toBe(true);
      expect(failed.text).toContain('pairing_expired');
      expect(failed.text).toContain('The pairing expired');

      const retry = await call(client, 'zas_pair');
      expect(retry.isError).toBe(false);
      expect(retry.text).toContain('/agents/pair?p=p1');
      expect(pair.started()).toBe(2);
      await client.close();
    });

    it('takes the code the page shows: refused before approval, a mismatch reported once, then paired', async () => {
      const pair = fakePair();
      const client = await connect(buildServer('p', { runPair: pair.impl, announceMs: 50 }));
      await call(client, 'zas_pair');

      const early = await call(client, 'zas_pair', { code: 'ABCD-EFGH' });
      expect(early.isError).toBe(true);
      expect(early.text).toContain('pairing_not_approved');

      // The poll said approved: runPair asks for a code and waits.
      const typed = pair.askCode();
      const wrong = call(client, 'zas_pair', { code: 'ABCD2345' });
      expect(await typed).toBe('ABCD2345');
      // A mismatch: runPair asks again, and the tool reads that as the answer.
      const again = pair.askCode();
      const mismatch = await wrong;
      expect(mismatch.isError).toBe(true);
      expect(mismatch.text).toContain('claim_mismatch');
      expect(mismatch.text).toContain('The code does not match');

      const right = call(client, 'zas_pair', { code: 'abcd-efgh' });
      // normalizePairingCode drops the hyphen and upper-cases: what askCode
      // resolves with is the canonical form, not the string as typed.
      expect(await again).toBe('ABCDEFGH');
      pair.resolve({ ...identity, name: 'Claude Code' });
      expect((await right).text).toBe('paired as Claude Code');
      expect(pair.started()).toBe(1);
      await client.close();
    });

    it('opens the browser unless ZAS_NO_OPEN is set', async () => {
      const pair = fakePair();
      const client = await connect(buildServer('p', { runPair: pair.impl, announceMs: 10 }));
      await call(client, 'zas_pair');
      expect(pair.opened()).toBe(true);
      expect(vi.mocked(openInBrowser)).toHaveBeenCalledWith('https://zas.red/agents/pair?p=p1#port=53211');
      await client.close();

      const callsBeforeNoOpen = vi.mocked(openInBrowser).mock.calls.length;
      process.env.ZAS_NO_OPEN = '1';
      try {
        const quiet = fakePair();
        const second = await connect(buildServer('p', { runPair: quiet.impl, announceMs: 10 }));
        await call(second, 'zas_pair');
        expect(quiet.opened()).toBe(false);
        // ZAS_NO_OPEN=1: server.ts never hands `open` to runPair, so the real
        // browser opener is not called again.
        expect(vi.mocked(openInBrowser)).toHaveBeenCalledTimes(callsBeforeNoOpen);
        await second.close();
      } finally {
        delete process.env.ZAS_NO_OPEN;
      }
    });
  });

  it('lists the jobs the runner holds', async () => {
    const runner = new JobRunner();
    const result: SendResult = {
      link_id: 'l1', channel_id: 'c1', channel_name: 'Trabajo',
      bytes: 4, chunks: 0, deduplicated: 0, replayed: false,
    };
    const job = runner.start('note', 'hola', 'c1', async () => result);
    await runner.wait(job);
    const client = await connect(buildServer('p', { identity, runner }));
    const answer = await call(client, 'zas_jobs');
    expect(JSON.parse(answer.text)).toMatchObject([{ kind: 'note', status: 'done', result: { link_id: 'l1' } }]);
    await client.close();
  });
});

describe('parseArgs', () => {
  it('serves the default profile with no arguments at all', () => {
    expect(parseArgs([])).toEqual({ command: 'serve', profile: 'claude-code' });
  });

  it('reads a profile, a kind and a host, joined or separated', () => {
    expect(parseArgs(['pair', '--profile', 'codex'])).toMatchObject({ command: 'pair', profile: 'codex' });
    expect(parseArgs(['pair', '--profile=codex', '--kind=other', '--host=laptop'])).toMatchObject({
      command: 'pair', profile: 'codex', kind: 'other', host: 'laptop',
    });
  });

  it('asks for the version and the usage', () => {
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['-h']).command).toBe('help');
  });

  it('stops on a kind it does not know instead of guessing "other"', () => {
    expect(parseArgs(['pair', '--kind', 'vscode'])).toMatchObject({ command: 'help', unknown: '--kind vscode' });
    expect(parseArgs(['--nope'])).toMatchObject({ command: 'help', unknown: '--nope' });
  });

  it('reads --no-open', () => {
    expect(parseArgs(['pair', '--no-open'])).toMatchObject({ command: 'pair', noOpen: true });
    expect(parseArgs(['pair'])).not.toHaveProperty('noOpen');
  });
});
