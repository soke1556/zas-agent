import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { agentSendIdempotencyKey } from '../src/shared/agent.js';
import { chunkStream } from '../src/shared/chunker.js';
import { blake3Bytes, blake3Hex, b64ToBytes, bytesToB64, bytesToHex, concatBytes, hmacSha256 } from '../src/shared/hash.js';
import { encryptChunk } from '../src/shared/mle.js';
import { encryptChannelName, openManifest } from '../src/shared/manifest.js';
import { oprfBlind, oprfEvaluate as oprfEvaluateServer, oprfFinalize, serverKeyFromSeed } from '../src/shared/oprf.js';
import { assignChannelKey, mintChannelKey } from '../src/shared/sharedchannel.js';
import type { ZasClient } from '../src/client.js';
import { errorFromResponse, ZasError } from '../src/errors.js';
import { defaultEndpoints, newKeyMaterial, profileDir, type Identity, type RemoteGrant } from '../src/identity.js';
import { MAX_REFUSALS_PER_SEND, mimeFor, OPRF_PROBE_BATCH, sendFile, sendNote, type SendContext } from '../src/send.js';

const SERVER_KEY = serverKeyFromSeed(new Uint8Array(32).fill(7));
const keys = newKeyMaterial();
const identity: Identity = {
  version: 1, agent_uid: `agent_${'A'.repeat(22)}`, owner_uid: 'owner-1', name: 'CC',
  kind: 'claude_code', host: 'box', ...keys, ...defaultEndpoints(),
};
const channelKey = mintChannelKey();

function grant(over: Partial<RemoteGrant> = {}): RemoteGrant {
  return {
    channel_id: 'ch1',
    send: true,
    read: false,
    wrapped_key: bytesToB64(assignChannelKey(b64ToBytes(keys.x25519_public), 1, channelKey)),
    key_version: 1,
    name_enc: bytesToB64(encryptChannelName(channelKey, 'Trabajo', 1)),
    mode: 'edit',
    direct_mode: false,
    ...over,
  };
}

/** The same derivation the pipeline runs, so a test can know the ciphertext a
 *  send will produce without watching it happen. `f` does not depend on the
 *  blind, so a fresh blind here lands on the same bytes. */
async function derive(data: Uint8Array) {
  const plains: Uint8Array[] = [];
  for await (const piece of chunkStream([data])) plains.push(piece);
  const out = [];
  for (const plain of plains) {
    const h = await blake3Bytes(plain);
    const { blind, blindedElement } = oprfBlind(h);
    const f = oprfFinalize(h, blind, oprfEvaluateServer(SERVER_KEY, blindedElement));
    out.push(await encryptChunk(f, plain));
  }
  return out;
}

interface LinkBody {
  channel_id: string;
  manifest_enc: string;
  caps: string[];
  proofs: { blob_id: string; challenge_id: string; mac: string }[];
  idempotency_key: string;
}

interface Challenge { challenge_id: string; nonce: string; offsets: number[]; sample_len: number }

function fakeServer(opts: {
  grants?: RemoteGrant[];
  challenges?: Record<string, Challenge>;
  /** What `POST /links` answers with under `caps`, keyed by the blob ids the
   *  sealed manifest it received actually holds. Default: none — a link that
   *  binds nothing, so the existing tests keep their behaviour. */
  linkCaps?: (blobIds: string[]) => Record<string, string>;
  /** The next `PATCH /links/:cid/:id` throws once, then behaves normally. */
  patchFailsOnce?: boolean;
  /** Every id comes back `blocked` from the probe. */
  blocked?: boolean;
  /** `POST /blobs/:id/prove` answers 403 proof_failed, as it does when the
   *  challenge aged past its two minutes or the canonical object went away. */
  proveFails?: boolean;
  /** How many `POST /blobs/:id/commit` calls answer 409 commit_pending before
   *  the blob finishes promoting. */
  commitPending?: number;
  /** The cap each path hands back. Per blob where a test has to tell chunks
   *  apart, one flat word otherwise. */
  commitCap?: (blobId: string) => string;
  proveCap?: (blobId: string) => string;
  /** The server's own array caps, asserted on every batched call. */
  maxBatch?: number;
  /** The OPRF answers one element short: the shape of a refused batch. */
  oprfShort?: boolean;
  /** The first OPRF slice answers one short and the next one long. The total
   *  adds up, so only a per-slice length check catches it. */
  oprfSkew?: boolean;
} = {}) {
  const grants = opts.grants ?? [grant()];
  const challenges = opts.challenges ?? {};
  const linkCaps = opts.linkCaps ?? (() => ({}));
  const commitCap = opts.commitCap ?? (() => 'cap-1');
  const proveCap = opts.proveCap ?? (() => 'proved-1');
  const maxBatch = opts.maxBatch ?? OPRF_PROBE_BATCH;
  let patchShouldFailOnce = opts.patchFailsOnce ?? false;
  let stillPending = opts.commitPending ?? 0;
  const calls: string[] = [];
  const puts: { url: string; body: Uint8Array }[] = [];
  const links: LinkBody[] = [];
  const patches: { path: string; manifest_enc: string }[] = [];
  const proves: { blob_id: string; challenge_id: string; mac: string }[] = [];
  const probes: string[][] = [];
  const oprfCalls: string[][] = [];
  const blobOf = (path: string): string => path.slice('/blobs/'.length, path.lastIndexOf('/'));

  const api = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/agents/me') {
      return { agent_uid: identity.agent_uid, owner_uid: identity.owner_uid, grants };
    }
    if (method === 'POST' && path === '/blobs/probe') {
      const ids = (body!.ids as string[]);
      expect(ids.length).toBeLessThanOrEqual(maxBatch);
      probes.push(ids);
      return {
        results: Object.fromEntries(ids.map(
          (id) => [id, opts.blocked ? 'blocked' : (challenges[id] ? 'prove' : 'upload')],
        )),
        challenges: Object.fromEntries(ids.filter((id) => challenges[id]).map((id) => [id, challenges[id]])),
      };
    }
    if (method === 'POST' && path.endsWith('/upload-url')) {
      return { upload_protocol: 1, upload_id: 'u1', url: 'http://put.local/x' };
    }
    if (method === 'POST' && path.endsWith('/commit')) {
      if (stillPending > 0) {
        stillPending -= 1;
        throw errorFromResponse(409, { error: 'commit_pending', retry: true });
      }
      return { cap: commitCap(blobOf(path)) };
    }
    if (method === 'POST' && path.endsWith('/prove')) {
      const blobId = blobOf(path);
      proves.push({ blob_id: blobId, ...(body as unknown as { challenge_id: string; mac: string }) });
      if (opts.proveFails) throw errorFromResponse(403, { error: 'proof_failed' });
      return { cap: proveCap(blobId) };
    }
    if (method === 'POST' && path === '/links') {
      const linkBody = body as unknown as LinkBody;
      links.push(linkBody);
      const blobIds = openManifest(channelKey, b64ToBytes(linkBody.manifest_enc)).chunks.map((c) => c.blob_id);
      return { link_id: 'L1', expires_at: 0, caps: linkCaps(blobIds) };
    }
    if (method === 'PATCH' && path.startsWith('/links/')) {
      if (patchShouldFailOnce) {
        patchShouldFailOnce = false;
        throw new ZasError('upload_failed', 500);
      }
      patches.push({ path, manifest_enc: (body as { manifest_enc: string }).manifest_enc });
      return {};
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    puts.push({ url: String(input), body: Uint8Array.from(init!.body as Uint8Array) });
    return new Response(null, { status: 200 });
  });

  const client = { identity, api, oprfEvaluate: vi.fn(async (blinded: string[]) => {
    expect(blinded.length).toBeLessThanOrEqual(maxBatch);
    oprfCalls.push(blinded);
    const out = blinded.map((b) => bytesToB64(oprfEvaluateServer(SERVER_KEY, b64ToBytes(b))));
    if (opts.oprfShort) return out.slice(0, -1);
    if (opts.oprfSkew) return oprfCalls.length === 1 ? out.slice(0, -1) : [...out, out[out.length - 1]];
    return out;
  }) } as unknown as ZasClient;

  return { api, calls, puts, links, patches, proves, probes, oprfCalls, client, fetchImpl, grants };
}

/** Pseudo-random, seeded and repeatable. The chunker cuts on content, so a
 *  repeated string is one chunk no matter how long it is; these bytes make it
 *  cut where the parameters say it should (1 MiB min, 4 MiB average). */
function pseudoRandom(seed: number, length: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 4) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
    out[i + 1] = (s >>> 8) & 255;
    out[i + 2] = (s >>> 16) & 255;
    out[i + 3] = (s >>> 24) & 255;
  }
  return out;
}

/** Seed 48 at 4 MiB is three chunks under the frozen chunker parameters. */
const THREE_CHUNKS = pseudoRandom(48, 4 * 1024 * 1024);

function manifestOf(links: LinkBody[], index = 0) {
  return openManifest(channelKey, b64ToBytes(links[index].manifest_enc));
}

describe('send', () => {
  let home: string;
  let dir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-send-'));
    dir = mkdtempSync(join(tmpdir(), 'zas-files-'));
    process.env.ZAS_AGENT_HOME = home;
  });
  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    vi.unstubAllGlobals();
    // Here, not at the end of the test that installs a spy: a failed assertion
    // would otherwise leak the spy into every test after it and bury the real
    // failure under cascading ones.
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string | Uint8Array): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it('chunks, encrypts, uploads and seals a file into the grant channel', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchImpl);
    const bytes = new TextEncoder().encode('hola mundo '.repeat(64));
    const path = write('informe.txt', bytes);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };
    const phases: string[] = [];

    const result = await sendFile(ctx, { path }, (phase) => phases.push(phase));

    expect(result).toEqual({
      link_id: 'L1', channel_id: 'ch1', channel_name: 'Trabajo',
      bytes: bytes.length, chunks: 1, deduplicated: 0, replayed: false,
    });
    expect(phases).toEqual(['hashing', 'encrypting', 'uploading', 'finishing']);
    expect(server.puts).toHaveLength(1);

    const manifest = manifestOf(server.links);
    expect(manifest.kind).toBe('file');
    expect(manifest.name).toBe('informe.txt');
    expect(manifest.title).toBeUndefined();
    expect(manifest.mime).toBe('text/plain');
    expect(manifest.size).toBe(bytes.length);
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.chunks[0].blob_id).toBe(await blake3Hex(server.puts[0].body));
    expect(manifest.chunks[0].cap).toBe('cap-1');
    expect(manifest.chunks[0].size).toBe(server.puts[0].body.length);

    expect(server.links[0].channel_id).toBe('ch1');
    expect(server.links[0].caps).toEqual(['cap-1']);
    expect(server.links[0].proofs).toEqual([]);
    expect(server.links[0].idempotency_key).toBe(
      agentSendIdempotencyKey('ch1', await blake3Hex(bytes), 'informe.txt'),
    );
    expect(Object.keys(server.links[0])).not.toContain('size_bytes');
  });

  it('replays the same file into the same channel without touching the network', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const first = await sendFile(ctx, { path });
    const before = server.api.mock.calls.length;
    const second = await sendFile(ctx, { path });

    expect(second).toEqual({ ...first, replayed: true });
    expect(server.api.mock.calls).toHaveLength(before);
    expect(server.puts).toHaveLength(1);
  });

  it('carries a chosen title without changing the file name, and keys the send by it', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchImpl);
    const bytes = new TextEncoder().encode('hola mundo '.repeat(64));
    const path = write('informe.txt', bytes);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await sendFile(ctx, { path, title: 'Informe de agosto' });

    const manifest = manifestOf(server.links);
    expect(manifest.name).toBe('informe.txt');
    expect(manifest.title).toBe('Informe de agosto');
    expect(server.links[0].idempotency_key).toBe(
      agentSendIdempotencyKey('ch1', await blake3Hex(bytes), 'Informe de agosto'),
    );
  });

  it('keeps the fingerprint cache key hashed, not the clear title', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const first = await sendFile(ctx, { path, title: 'Informe secreto' });
    const raw = readFileSync(join(profileDir('p'), 'fingerprints.json'), 'utf8');
    expect(raw).not.toContain('Informe secreto');

    const second = await sendFile(ctx, { path, title: 'Informe secreto' });
    expect(second).toEqual({ ...first, replayed: true });
  });

  it('binds the caps the link answers with and writes the manifest back', async () => {
    const server = fakeServer({
      linkCaps: (ids) => Object.fromEntries(ids.map((id) => [id, `bound-${id}`])),
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const bytes = new TextEncoder().encode('hola mundo '.repeat(64));
    const path = write('informe.txt', bytes);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await sendFile(ctx, { path });

    expect(server.patches).toHaveLength(1);
    expect(server.patches[0].path).toBe('/links/ch1/L1');
    const patched = openManifest(channelKey, b64ToBytes(server.patches[0].manifest_enc));
    expect(patched.chunks.every((c) => c.cap === `bound-${c.blob_id}`)).toBe(true);
  });

  it('does not write the manifest back when the link answers no caps', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await sendFile(ctx, { path });

    expect(server.patches).toHaveLength(0);
  });

  it('does not remember a send whose write-back failed', async () => {
    const server = fakeServer({
      linkCaps: (ids) => Object.fromEntries(ids.map((id) => [id, `bound-${id}`])),
      patchFailsOnce: true,
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'upload_failed', status: 500 });
    expect(server.links).toHaveLength(1);
    expect(server.patches).toHaveLength(0);

    const second = await sendFile(ctx, { path });

    expect(second.replayed).toBe(false);
    expect(server.links).toHaveLength(2);
    expect(server.patches).toHaveLength(1);
  });

  it('retries a failed chunk PUT once after a 5xx, then succeeds', async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      server.puts.push({ url: String(input), body: Uint8Array.from(init!.body as Uint8Array) });
      return server.puts.length === 1
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendFile(ctx, { path });

    expect(result.chunks).toBe(1);
    expect(server.puts).toHaveLength(2);
    expect(server.calls.filter((c) => c.endsWith('/commit'))).toHaveLength(1);
  }, 10000);

  it('retries a chunk PUT once after a thrown fetch, then succeeds', async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      server.puts.push({ url: String(input), body: Uint8Array.from(init!.body as Uint8Array) });
      if (server.puts.length === 1) throw new TypeError('fetch failed');
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendFile(ctx, { path });

    expect(result.chunks).toBe(1);
    expect(server.puts).toHaveLength(2);
  }, 10000);

  it('names a chunk PUT that throws twice instead of letting the fetch error out', async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'upload_failed', status: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10000);

  it('does not retry a 4xx chunk PUT', async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      server.puts.push({ url: String(input), body: Uint8Array.from(init!.body as Uint8Array) });
      return new Response(null, { status: 403 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'upload_failed', status: 403 });
    expect(server.puts).toHaveLength(1);
  });

  it('proves a chunk the server already holds instead of uploading it', async () => {
    const bytes = new TextEncoder().encode('bytes que ya estan '.repeat(64));
    const [enc] = await derive(bytes);
    const challenge: Challenge = {
      challenge_id: 'chal-1',
      nonce: bytesToB64(new Uint8Array(32).fill(9)),
      offsets: [0, 7, 40],
      sample_len: 64,
    };
    const server = fakeServer({
      challenges: { [enc.blobId]: challenge },
      proveCap: (id) => `proved-${id}`,
      linkCaps: (ids) => Object.fromEntries(ids.map((id) => [id, `bound-${id}`])),
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('viejo.bin', bytes);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendFile(ctx, { path });

    expect(result.deduplicated).toBe(1);
    expect(server.puts).toHaveLength(0);
    // The proof goes to its own route, right after the probe, while the
    // challenge is minutes old rather than an upload old.
    const samples = challenge.offsets.map((o) => enc.ciphertext.slice(o, o + challenge.sample_len));
    expect(server.proves).toEqual([{
      blob_id: enc.blobId,
      challenge_id: 'chal-1',
      mac: bytesToHex(hmacSha256(b64ToBytes(challenge.nonce), concatBytes(...samples))),
    }]);
    expect(server.calls.filter((c) => c.endsWith('/prove'))).toHaveLength(1);
    expect(server.links[0].proofs).toEqual([]);
    expect(server.links[0].caps).toEqual([`proved-${enc.blobId}`]);
    expect(manifestOf(server.links).chunks[0].cap).toBe(`proved-${enc.blobId}`);

    expect(server.patches).toHaveLength(1);
    const patched = openManifest(channelKey, b64ToBytes(server.patches[0].manifest_enc));
    expect(patched.chunks[0].cap).toBe(`bound-${enc.blobId}`);
  });

  it('falls back to uploading when the proof is refused', async () => {
    const bytes = new TextEncoder().encode('bytes que ya estan '.repeat(64));
    const [enc] = await derive(bytes);
    const server = fakeServer({
      challenges: {
        [enc.blobId]: {
          challenge_id: 'chal-1',
          nonce: bytesToB64(new Uint8Array(32).fill(9)),
          offsets: [0, 7, 40],
          sample_len: 64,
        },
      },
      proveFails: true,
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('viejo.bin', bytes);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendFile(ctx, { path });

    expect(result.deduplicated).toBe(0);
    expect(server.calls.filter((c) => c.endsWith('/prove'))).toHaveLength(1);
    expect(server.puts).toHaveLength(1);
    expect(server.calls.filter((c) => c.endsWith('/commit'))).toHaveLength(1);
    expect(manifestOf(server.links).chunks[0].cap).toBe('cap-1');
    expect(server.links[0].proofs).toEqual([]);
  });

  it('proves one chunk, uploads the rest, and binds a cap for every one', async () => {
    const encs = await derive(THREE_CHUNKS);
    expect(encs).toHaveLength(3);
    const challenge: Challenge = {
      challenge_id: 'chal-2',
      nonce: bytesToB64(new Uint8Array(32).fill(3)),
      offsets: [0, 11, 500],
      sample_len: 64,
    };
    const server = fakeServer({
      challenges: { [encs[1].blobId]: challenge },
      commitCap: (id) => `cap-${id}`,
      proveCap: (id) => `proved-${id}`,
      linkCaps: (ids) => Object.fromEntries(ids.map((id) => [id, `bound-${id}`])),
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('mezcla.bin', THREE_CHUNKS);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendFile(ctx, { path });

    expect(result).toMatchObject({ chunks: 3, deduplicated: 1, bytes: THREE_CHUNKS.length });
    expect(server.puts).toHaveLength(2);
    expect(server.proves.map((p) => p.blob_id)).toEqual([encs[1].blobId]);

    // The order of `caps` is the order of the manifest chunks, which is the
    // order of the file. The server binds them positionally.
    const manifest = manifestOf(server.links);
    expect(manifest.chunks.map((c) => c.blob_id)).toEqual(encs.map((e) => e.blobId));
    expect(server.links[0].caps).toEqual(manifest.chunks.map((c) => c.cap));
    expect(server.links[0].caps).toEqual([
      `cap-${encs[0].blobId}`, `proved-${encs[1].blobId}`, `cap-${encs[2].blobId}`,
    ]);
    expect(server.links[0].proofs).toEqual([]);

    const patched = openManifest(channelKey, b64ToBytes(server.patches[0].manifest_enc));
    expect(patched.chunks.map((c) => c.cap)).toEqual(encs.map((e) => `bound-${e.blobId}`));
  }, 30000);

  it('slices the OPRF and the probe to the server array caps', async () => {
    const encs = await derive(THREE_CHUNKS);
    const server = fakeServer({ maxBatch: 2 });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('grande.bin', THREE_CHUNKS);
    const ctx: SendContext = { identity, client: server.client, profile: 'p', batch: 2 };

    const result = await sendFile(ctx, { path });

    expect(result.chunks).toBe(3);
    expect(server.oprfCalls.map((c) => c.length)).toEqual([2, 1]);
    expect(server.probes.map((p) => p.length)).toEqual([2, 1]);
    const manifest = manifestOf(server.links);
    expect(manifest.size).toBe(THREE_CHUNKS.length);
    expect(manifest.chunks.map((c) => c.blob_id)).toEqual(encs.map((e) => e.blobId));
    expect(manifest.chunks.map((c) => c.size)).toEqual(encs.map((e) => e.ciphertext.length));
  }, 30000);

  it('retries a commit the server says is still promoting', async () => {
    const server = fakeServer({ commitPending: 2 });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendFile(ctx, { path });

    expect(result.chunks).toBe(1);
    expect(server.calls.filter((c) => c.endsWith('/commit'))).toHaveLength(3);
    expect(server.puts).toHaveLength(1);
    expect(manifestOf(server.links).chunks[0].cap).toBe('cap-1');
  }, 20000);

  it('gives up on a commit that never stops being pending', async () => {
    const server = fakeServer({ commitPending: 5 });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'upload_failed', status: 409 });
    expect(server.calls.filter((c) => c.endsWith('/commit'))).toHaveLength(4);
    expect(server.links).toHaveLength(0);
  }, 20000);

  it('refuses when the OPRF answers fewer elements than it was asked for', async () => {
    const server = fakeServer({ oprfShort: true });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'oprf_failed', status: 0 });
    expect(server.puts).toHaveLength(0);
    expect(server.links).toHaveLength(0);
  });

  it('names a blob the probe refuses outright', async () => {
    const server = fakeServer({ blocked: true });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'upload_failed', status: 451 });
    expect(server.puts).toHaveLength(0);
    expect(server.links).toHaveLength(0);
  });

  it('puts a thumbnail in the manifest for an image', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchImpl);
    const png = new Uint8Array(await new Jimp({ width: 300, height: 200, color: 0x00ff00ff }).getBuffer('image/png'));
    const path = write('foto.png', png);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await sendFile(ctx, { path });

    const manifest = manifestOf(server.links);
    expect(manifest.mime).toBe('image/png');
    expect(manifest.thumb_data?.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('refuses a file over the hard stop before it reads a byte', async () => {
    const server = fakeServer();
    const path = write('grande.bin', 'x');
    const stat = await import('node:fs');
    vi.spyOn(stat.promises, 'stat')
      .mockResolvedValue({ size: 6 * 1024 * 1024 * 1024, isFile: () => true } as never);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };
    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'file_too_big', status: 413 });
    expect(server.api).not.toHaveBeenCalled();
  });

  it('refuses a path that is not a regular file, and one that is not there', async () => {
    const server = fakeServer();
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    // A directory, a FIFO or a character device all report size 0, so the size
    // guard never fires and the read would run to EOF — /dev/zero for ever.
    await expect(sendFile(ctx, { path: dir })).rejects.toMatchObject({ code: 'upload_failed', status: 400 });
    await expect(sendFile(ctx, { path: join(dir, 'no-existe.txt') }))
      .rejects.toMatchObject({ code: 'upload_failed', status: 400 });
    expect(server.api).not.toHaveBeenCalled();
  });

  it('refuses a path it cannot stat, whatever the reason', async () => {
    const server = fakeServer();
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };
    const path = write('archivo.txt', 'x');

    // A path *under* a regular file: ENOTDIR on POSIX, ENOENT on Windows.
    await expect(sendFile(ctx, { path: join(path, 'x') }))
      .rejects.toMatchObject({ code: 'upload_failed', status: 400 });

    // And the one no test can provoke on demand: a stat the OS refuses. The
    // caller gave a path the agent cannot use — the reason is the caller's
    // business, not a raw errno printed at a terminal.
    const fs = await import('node:fs');
    vi.spyOn(fs.promises, 'stat')
      .mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) as never);
    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'upload_failed', status: 400 });
    expect(server.api).not.toHaveBeenCalled();
  });

  it('survives a fingerprints file that lost its entries', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchImpl);
    mkdirSync(profileDir('p'), { recursive: true });
    writeFileSync(join(profileDir('p'), 'fingerprints.json'), '{}');
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await expect(sendFile(ctx, { path })).resolves.toMatchObject({ link_id: 'L1', replayed: false });
  });

  it('sends a note as a text manifest, with the secret cover when asked', async () => {
    const server = fakeServer();
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendNote(ctx, { text: 'primera linea\nsegunda linea', lang: 'ts', secret: true });

    expect(result).toEqual({
      link_id: 'L1', channel_id: 'ch1', channel_name: 'Trabajo',
      bytes: 27, chunks: 0, deduplicated: 0, replayed: false,
    });
    const manifest = manifestOf(server.links);
    expect(manifest.kind).toBe('text');
    expect(manifest.name).toBe('primera linea');
    expect(manifest.title).toBeUndefined();
    expect(manifest.mime).toBe('text/plain');
    expect(manifest.text).toBe('primera linea\nsegunda linea');
    expect(manifest.sensitive).toBe(true);
    expect(manifest.code).toEqual({ lang: 'ts', auto: false });
    expect(manifest.chunks).toEqual([]);
    expect(server.links[0].caps).toEqual([]);
    expect(server.links[0].proofs).toEqual([]);
    expect(server.links[0].idempotency_key).toBe(agentSendIdempotencyKey(
      'ch1',
      // The flags are inside the hash: a note is the text plus what the sender
      // said about it, and two sends that differ only in `secret` are two items.
      await blake3Hex(new TextEncoder().encode('ts\x001\x00primera linea\nsegunda linea')),
      'primera linea',
    ));
  });

  it('keys a note by its flags, so the same text marked secret is a new send', async () => {
    const server = fakeServer();
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const first = await sendNote(ctx, { text: 'la misma nota' });
    const second = await sendNote(ctx, { text: 'la misma nota', secret: true });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(server.links).toHaveLength(2);
    expect(manifestOf(server.links, 0).sensitive).toBeUndefined();
    expect(manifestOf(server.links, 1).sensitive).toBe(true);
    expect(server.links[0].idempotency_key).not.toBe(server.links[1].idempotency_key);
  });

  it('clips a long first line into the note name and leaves an unmarked note unmarked', async () => {
    const server = fakeServer();
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };
    await sendNote(ctx, { text: `${'a'.repeat(80)}\nmas` });
    const manifest = manifestOf(server.links);
    expect(manifest.name).toBe('a'.repeat(40));
    expect(manifest.sensitive).toBeUndefined();
    expect(manifest.code).toBeUndefined();
  });

  it('stops before any upload when the grant cannot send', async () => {
    const cases: [Partial<RemoteGrant>, string][] = [
      [{ send: false }, 'send_forbidden'],
      [{ mode: 'view' }, 'send_forbidden'],
      [{ direct_mode: true }, 'direct_mode'],
    ];
    for (const [over, code] of cases) {
      const server = fakeServer({ grants: [grant(over)] });
      vi.stubGlobal('fetch', server.fetchImpl);
      const path = write('informe.txt', 'hola');
      const ctx: SendContext = { identity, client: server.client, profile: `p-${code}-${String(over.send)}${String(over.mode)}` };
      await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code });
      await expect(sendNote(ctx, { text: 'hola' })).rejects.toMatchObject({ code });
      expect(server.links).toHaveLength(0);
      expect(server.puts).toHaveLength(0);
    }
  });

  it('proves a slice before it uploads any of it', async () => {
    const encs = await derive(THREE_CHUNKS);
    const server = fakeServer({
      challenges: { [encs[1].blobId]: {
          challenge_id: 'chal-order',
          nonce: bytesToB64(new Uint8Array(32).fill(5)),
          offsets: [0, 11, 500],
          sample_len: 64,
        } },
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('orden.bin', THREE_CHUNKS);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await sendFile(ctx, { path });

    // A challenge lives two minutes and an upload can take longer than that,
    // so no proof of a slice may wait behind an upload of the same slice.
    const firstProve = server.calls.findIndex((c) => c.endsWith('/prove'));
    const firstUpload = server.calls.findIndex((c) => c.endsWith('/upload-url'));
    expect(firstProve).toBeGreaterThan(-1);
    expect(firstUpload).toBeGreaterThan(firstProve);
  }, 30000);

  it('stops proving a slice after the first refusal and uploads the rest', async () => {
    const encs = await derive(THREE_CHUNKS);
    const server = fakeServer({
      challenges: Object.fromEntries(encs.map((e) => [e.blobId, {
          challenge_id: 'chal-batch',
          nonce: bytesToB64(new Uint8Array(32).fill(5)),
          offsets: [0, 11, 500],
          sample_len: 64,
        }])),
      proveFails: true,
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('viejos.bin', THREE_CHUNKS);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendFile(ctx, { path });

    // The challenges of a slice are all the same age, so one refusal is the
    // whole news; every further one spends a unit of the ten the server
    // allows per hour, and the eleventh answers 429 and kills the send.
    expect(server.proves).toHaveLength(1);
    expect(server.puts).toHaveLength(3);
    expect(result.deduplicated).toBe(0);
  }, 30000);

  it('stops proving for the whole send once it has spent its refusals', async () => {
    // `refused` is per slice, so a long file could spend one unit per slice
    // and leave the hour's budget empty for the next send. The send-wide
    // counter caps what one send can spend, and everything after it uploads.
    const encs = await derive(THREE_CHUNKS);
    const server = fakeServer({
      maxBatch: 2,
      challenges: Object.fromEntries(encs.map((e) => [e.blobId, {
          challenge_id: 'chal-budget',
          nonce: bytesToB64(new Uint8Array(32).fill(5)),
          offsets: [0, 11, 500],
          sample_len: 64,
        }])),
      proveFails: true,
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('presupuesto.bin', THREE_CHUNKS);
    const ctx: SendContext = { identity, client: server.client, profile: 'p', batch: 2 };

    const result = await sendFile(ctx, { path });

    expect(server.probes.map((p) => p.length)).toEqual([2, 1]);
    // One per slice while the budget lasts, and never more than the budget.
    expect(server.proves.length).toBeLessThanOrEqual(MAX_REFUSALS_PER_SEND);
    expect(server.proves).toHaveLength(2);
    // The send still finishes: everything the server refused went up.
    expect(server.puts).toHaveLength(3);
    expect(result.deduplicated).toBe(0);
    expect(result.chunks).toBe(3);
  }, 30000);

  it('places one slice before it probes the next', async () => {
    const server = fakeServer({ maxBatch: 2 });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('grande.bin', THREE_CHUNKS);
    const ctx: SendContext = { identity, client: server.client, profile: 'p', batch: 2 };

    await sendFile(ctx, { path });

    const probeAt = server.calls.flatMap((c, i) => (c === 'POST /blobs/probe' ? [i] : []));
    expect(probeAt).toHaveLength(2);
    expect(server.probes.map((p) => p.length)).toEqual([2, 1]);
    // The second slice is challenged only when it is about to be placed.
    expect(server.calls.slice(0, probeAt[1]).filter((c) => c.endsWith('/commit'))).toHaveLength(2);
    expect(server.calls.slice(probeAt[1]).filter((c) => c.endsWith('/commit'))).toHaveLength(1);
  }, 30000);

  it('places a chunk that repeats inside one file once, and copies its cap', async () => {
    const plains: Uint8Array[] = [];
    for await (const piece of chunkStream([THREE_CHUNKS])) plains.push(piece);
    const doubled = concatBytes(plains[0], plains[0]);
    const encs = await derive(doubled);
    // The chunker cuts on content, so the same bytes twice are the same chunk
    // twice. If that ever stops holding, the test below tests nothing.
    expect(encs).toHaveLength(2);
    expect(encs[1].blobId).toBe(encs[0].blobId);

    const server = fakeServer({
      challenges: { [encs[0].blobId]: {
          challenge_id: 'chal-twice',
          nonce: bytesToB64(new Uint8Array(32).fill(5)),
          offsets: [0, 11, 500],
          sample_len: 64,
        } },
      proveCap: (id) => `proved-${id}`,
    });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('repetido.bin', doubled);
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const result = await sendFile(ctx, { path });

    // One id, one challenge: the server deletes a challenge when it is proven,
    // so a second placement of the same id would always be refused.
    expect(server.probes).toEqual([[encs[0].blobId]]);
    expect(server.proves).toHaveLength(1);
    expect(server.puts).toHaveLength(0);
    const manifest = manifestOf(server.links);
    expect(manifest.chunks.map((c) => c.blob_id)).toEqual([encs[0].blobId, encs[0].blobId]);
    expect(manifest.chunks.map((c) => c.cap)).toEqual([
      `proved-${encs[0].blobId}`, `proved-${encs[0].blobId}`,
    ]);
    expect(result).toMatchObject({ chunks: 2, deduplicated: 2 });
  }, 30000);

  it('refuses an OPRF slice whose answer is not the length of its request', async () => {
    const server = fakeServer({ maxBatch: 2, oprfSkew: true });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('grande.bin', THREE_CHUNKS);
    const ctx: SendContext = { identity, client: server.client, profile: 'p', batch: 2 };

    // The totals add up; only the per-slice lengths do not, and one short
    // answer followed by one long one pairs every hash after it with the
    // wrong evaluation.
    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'oprf_failed', status: 0 });
    expect(server.puts).toHaveLength(0);
    expect(server.links).toHaveLength(0);
  }, 30000);

  it('names a chunk PUT the object store refuses twice with a 5xx', async () => {
    const server = fakeServer();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      server.puts.push({ url: String(input), body: Uint8Array.from(init!.body as Uint8Array) });
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const path = write('informe.txt', 'hola mundo '.repeat(64));
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    await expect(sendFile(ctx, { path })).rejects.toMatchObject({ code: 'upload_failed', status: 503 });
    expect(server.puts).toHaveLength(2);
    expect(server.calls.filter((c) => c.endsWith('/commit'))).toHaveLength(0);
  }, 10000);

  it('replays an unchanged note from the receipt, without a second link', async () => {
    const server = fakeServer();
    const ctx: SendContext = { identity, client: server.client, profile: 'p' };

    const first = await sendNote(ctx, { text: 'la misma nota', lang: 'ts' });
    const second = await sendNote(ctx, { text: 'la misma nota', lang: 'ts' });

    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(server.links).toHaveLength(1);
  });

  it('names the common types and shrugs at the rest', () => {
    expect(mimeFor('a/b/c.PNG')).toBe('image/png');
    expect(mimeFor('notes.md')).toBe('text/markdown');
    expect(mimeFor('main.ts')).toBe('text/typescript');
    expect(mimeFor('deck.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(mimeFor('archivo.sin-extension')).toBe('application/octet-stream');
    expect(mimeFor('LICENSE')).toBe('application/octet-stream');
  });
});
