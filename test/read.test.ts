import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { b64ToBytes, bytesToB64 } from '../src/shared/hash.js';
import { encryptChannelName, newManifest, sealManifest, type Manifest } from '../src/shared/manifest.js';
import { encryptRandomChunk } from '../src/shared/mle.js';
import { assignChannelKey, mintChannelKey } from '../src/shared/sharedchannel.js';
import type { ZasClient } from '../src/client.js';
import { ZasError } from '../src/errors.js';
import { defaultEndpoints, newKeyMaterial, type Identity, type RemoteGrant } from '../src/identity.js';
import { getItem, listItems } from '../src/read.js';
import type { SendContext } from '../src/send.js';

const keys = newKeyMaterial();
const identity: Identity = {
  version: 1, agent_uid: `agent_${'A'.repeat(22)}`, owner_uid: 'owner-1', name: 'CC',
  kind: 'claude_code', host: 'box', ...keys, ...defaultEndpoints(),
};
const channelKey = mintChannelKey();
const otherKey = mintChannelKey();

function grant(over: Partial<RemoteGrant> = {}): RemoteGrant {
  return {
    channel_id: 'ch1',
    send: true,
    read: true,
    wrapped_key: bytesToB64(assignChannelKey(b64ToBytes(keys.x25519_public), 1, channelKey)),
    key_version: 1,
    name_enc: bytesToB64(encryptChannelName(channelKey, 'Trabajo', 1)),
    mode: 'edit',
    direct_mode: false,
    ...over,
  };
}

const DOC_ROOT = `projects/${identity.firestore_project}/databases/(default)/documents`;

/** One `links` document in the shape Firestore REST answers with. */
function linkDoc(id: string, fields: Record<string, unknown>): unknown {
  return {
    name: `${DOC_ROOT}/accounts/${identity.owner_uid}/channels/ch1/links/${id}`,
    fields,
    createTime: '2026-09-01T10:00:00.000000Z',
    updateTime: '2026-09-01T10:00:00.000000Z',
  };
}

function sealedOf(manifest: Manifest, key = channelKey): string {
  return bytesToB64(sealManifest(key, manifest, 1));
}

function note(text: string, over: Partial<Manifest> = {}): Manifest {
  return newManifest({
    kind: 'text', name: 'nota', mime: 'text/plain', size: text.length,
    created_at: '2026-09-01T10:00:00.000Z', text, chunks: [], ...over,
  });
}

interface QueryCall { parent: string; query: Record<string, unknown> }

function fakeServer(opts: {
  grants?: RemoteGrant[];
  docs?: unknown[];
  runQuery?: (parent: string, query: Record<string, unknown>) => Promise<unknown[]>;
} = {}) {
  const grants = opts.grants ?? [grant()];
  const queries: QueryCall[] = [];

  const api = vi.fn(async (method: string, path: string) => {
    if (method === 'GET' && path === '/agents/me') {
      return { agent_uid: identity.agent_uid, owner_uid: identity.owner_uid, grants };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  const firestoreRunQuery = vi.fn(async (parent: string, query: Record<string, unknown>) => {
    queries.push({ parent, query });
    if (opts.runQuery) return opts.runQuery(parent, query);
    return opts.docs ?? [];
  });

  const idToken = vi.fn(async () => 'id-token-1');
  const client = { identity, api, firestoreRunQuery, idToken } as unknown as ZasClient;
  return { api, client, queries, firestoreRunQuery };
}

/** Redeem answers a per-cap URL; the URL answers the ciphertext stored under it. */
function fakeFetch(opts: { blobs?: Record<string, Uint8Array>; redeemStatus?: number; blobStatus?: number } = {}) {
  const blobs = opts.blobs ?? {};
  const redeemed: string[] = [];
  const fetched: string[] = [];
  const authorizations: unknown[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/blobs/redeem')) {
      const { cap } = JSON.parse(String(init!.body)) as { cap: string };
      redeemed.push(cap);
      authorizations.push((init!.headers as Record<string, string>).Authorization);
      if (opts.redeemStatus && opts.redeemStatus !== 200) {
        return new Response(JSON.stringify({ error: 'cap_invalid' }), {
          status: opts.redeemStatus, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ url: `https://blob.local/${cap}` }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    fetched.push(url);
    if (opts.blobStatus && opts.blobStatus !== 200) return new Response(null, { status: opts.blobStatus });
    const body = blobs[url.slice(url.lastIndexOf('/') + 1)];
    if (!body) return new Response(null, { status: 404 });
    return new Response(body as unknown as BodyInit, { status: 200 });
  });
  return { impl, redeemed, fetched, authorizations };
}

/** Every half-written download left under `root`. A finished write renames its
 *  temporary away; a failed one must delete it, because it holds plaintext. */
function tmpLeftovers(root: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** A file manifest whose chunks really decrypt to `data`, cut at `at`. */
async function fileItem(data: Uint8Array, at: number[] = []) {
  const cuts = [0, ...at, data.length];
  const blobs: Record<string, Uint8Array> = {};
  const chunks = [];
  for (let i = 1; i < cuts.length; i++) {
    const enc = await encryptRandomChunk(data.slice(cuts[i - 1], cuts[i]));
    const cap = `cap-${i}`;
    blobs[cap] = enc.ciphertext;
    chunks.push({
      blob_id: enc.blobId, key: bytesToB64(enc.key), nonce: bytesToB64(enc.nonce),
      size: enc.ciphertext.length, cap,
    });
  }
  const manifest = newManifest({
    kind: 'file', name: 'informe.txt', mime: 'text/plain', size: data.length,
    created_at: '2026-09-01T10:00:00.000Z', chunks,
  });
  return { manifest, blobs };
}

describe('read', () => {
  let home: string;
  let dir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-read-'));
    dir = mkdtempSync(join(tmpdir(), 'zas-dest-'));
    process.env.ZAS_AGENT_HOME = home;
  });
  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  const ctxOf = (client: ZasClient): SendContext => ({ identity, client, profile: 'p' });

  it('lists what it can open and skips what it cannot', async () => {
    const { manifest } = await fileItem(new TextEncoder().encode('hola'));
    const server = fakeServer({
      docs: [
        linkDoc('L1', {
          manifest_enc: { stringValue: sealedOf(note('primera nota')) },
          created_at: { timestampValue: '2026-09-01T10:00:00Z' },
          expires_at: { nullValue: null },
          agent: { stringValue: identity.agent_uid },
        }),
        // Sealed under a key this agent does not hold: a member's client would
        // skip it too.
        linkDoc('L2', {
          manifest_enc: { stringValue: sealedOf(note('ajena'), otherKey) },
          created_at: { timestampValue: '2026-09-01T09:00:00Z' },
        }),
        // A burned row: the ciphertext is gone, the row is not.
        linkDoc('L3', {
          bar: { booleanValue: true },
          created_at: { timestampValue: '2026-09-01T08:00:00Z' },
        }),
        linkDoc('L4', {
          manifest_enc: { stringValue: sealedOf(manifest) },
          created_at: { timestampValue: '2026-09-01T07:00:00Z' },
        }),
        // Already past its departure: the feed drops it too (Main.tsx:1412).
        linkDoc('L5', {
          manifest_enc: { stringValue: sealedOf(note('vencida')) },
          created_at: { timestampValue: '2026-08-01T10:00:00Z' },
          expires_at: { timestampValue: '2026-08-08T10:00:00Z' },
        }),
      ],
    });

    const out = await listItems(ctxOf(server.client), undefined);

    expect(out.channel_id).toBe('ch1');
    expect(out.channel_name).toBe('Trabajo');
    expect(out.items.map((i) => i.id)).toEqual(['L1', 'L4']);
    expect(out.items[0]).toEqual({
      id: 'L1', kind: 'text', title: 'nota', name: 'nota', mime: 'text/plain',
      size: 'primera nota'.length, created_at: '2026-09-01T10:00:00.000Z',
      by_agent: true, text: 'primera nota',
    });
    expect(out.items[1].kind).toBe('file');
    expect(out.items[1].by_agent).toBe(false);
    expect(out.items[1].text).toBeUndefined();
  });

  it('prefers the manifest title over the file name', async () => {
    const { manifest } = await fileItem(new TextEncoder().encode('hola'));
    manifest.title = 'Informe de agosto';
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });

    const out = await listItems(ctxOf(server.client), 'ch1');

    expect(out.items[0].title).toBe('Informe de agosto');
    expect(out.items[0].name).toBe('informe.txt');
  });

  it('asks for the newest twenty by default and clamps what it is given', async () => {
    const server = fakeServer();
    await listItems(ctxOf(server.client), 'ch1');
    await listItems(ctxOf(server.client), 'ch1', 5);
    await listItems(ctxOf(server.client), 'ch1', 500);
    await listItems(ctxOf(server.client), 'ch1', 0);

    expect(server.queries.map((q) => q.query.limit)).toEqual([20, 5, 50, 1]);
    expect(server.queries[0].parent).toBe(`accounts/${identity.owner_uid}/channels/ch1`);
    expect(server.queries[0].query).toMatchObject({
      from: [{ collectionId: 'links' }],
      orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
    });
  });

  it('refuses a channel without a read grant before it touches the network', async () => {
    const server = fakeServer({ grants: [grant({ read: false })] });

    await expect(listItems(ctxOf(server.client), 'ch1')).rejects.toMatchObject({
      code: 'read_forbidden', status: 403,
    });
    expect(server.firestoreRunQuery).not.toHaveBeenCalled();
  });

  it('reads a view-only channel: view blocks sends, not reads', async () => {
    const server = fakeServer({
      grants: [grant({ mode: 'view', send: false })],
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(note('hola')) } })],
    });

    const out = await listItems(ctxOf(server.client), 'ch1');
    expect(out.items.map((i) => i.id)).toEqual(['L1']);
  });

  it('turns a Firestore permission denial into read_forbidden', async () => {
    const server = fakeServer({
      runQuery: async () => { throw new ZasError('http_403', 403); },
    });

    await expect(listItems(ctxOf(server.client), 'ch1')).rejects.toMatchObject({
      code: 'read_forbidden', status: 403,
    });
  });

  it('answers a note with its text and writes nothing', async () => {
    const text = 'la nota entera';
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(note(text)) } })],
    });
    const fetcher = fakeFetch();
    vi.stubGlobal('fetch', fetcher.impl);

    const out = await getItem(ctxOf(server.client), 'ch1', 'L1');

    expect(out).toEqual({ text, bytes: new TextEncoder().encode(text).length });
    expect(fetcher.impl).not.toHaveBeenCalled();
    expect(server.queries[0].query).toMatchObject({
      limit: 1,
      where: {
        fieldFilter: {
          field: { fieldPath: '__name__' },
          op: 'EQUAL',
          value: { referenceValue: `${DOC_ROOT}/accounts/${identity.owner_uid}/channels/ch1/links/L1` },
        },
      },
    });
  });

  it('redeems every cap, decrypts the chunks in order and writes the file', async () => {
    const data = new TextEncoder().encode('hola mundo '.repeat(40));
    const { manifest, blobs } = await fileItem(data, [100, 300]);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    const fetcher = fakeFetch({ blobs });
    vi.stubGlobal('fetch', fetcher.impl);
    const dest = join(dir, 'bajado.txt');

    const out = await getItem(ctxOf(server.client), 'ch1', 'L1', dest);

    expect(out).toEqual({ path: dest, bytes: data.length });
    expect(fetcher.redeemed).toEqual(['cap-1', 'cap-2', 'cap-3']);
    // The web presents its session on the public redeem so an organization's
    // objects can re-check membership; so does the agent.
    expect(fetcher.authorizations).toEqual(['Bearer id-token-1', 'Bearer id-token-1', 'Bearer id-token-1']);
    expect(new Uint8Array(readFileSync(dest))).toEqual(data);
  });

  it('writes into a fresh private directory when no destination is given', async () => {
    const data = new TextEncoder().encode('sin destino');
    const { manifest, blobs } = await fileItem(data);
    manifest.name = '../../etc/.passwd';
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    vi.stubGlobal('fetch', fakeFetch({ blobs }).impl);

    const first = await getItem(ctxOf(server.client), 'ch1', 'L1');
    const second = await getItem(ctxOf(server.client), 'ch1', 'L1');

    expect(basename(first.path!)).toBe('passwd');
    expect(basename(dirname(first.path!)).startsWith('zas-agent-')).toBe(true);
    expect(dirname(dirname(first.path!))).toBe(tmpdir());
    expect(new Uint8Array(readFileSync(first.path!))).toEqual(data);
    // A directory of its own per call: two downloads of the same name can run
    // at once without either returning the other's bytes.
    expect(dirname(second.path!)).not.toBe(dirname(first.path!));
    // The claim the comment in read.ts makes: nobody else on the machine reads
    // what this agent fetched.
    if (process.platform !== 'win32') expect(statSync(first.path!).mode & 0o777).toBe(0o600);
    rmSync(dirname(first.path!), { recursive: true, force: true });
    rmSync(dirname(second.path!), { recursive: true, force: true });
  });

  it('puts the file inside a destination that is already a directory', async () => {
    const data = new TextEncoder().encode('adentro');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    vi.stubGlobal('fetch', fakeFetch({ blobs }).impl);
    const dest = join(dir, 'bajados');
    mkdirSync(dest);

    const out = await getItem(ctxOf(server.client), 'ch1', 'L1', dest);

    expect(out.path).toBe(join(dest, 'informe.txt'));
    expect(new Uint8Array(readFileSync(out.path!))).toEqual(data);
  });

  it('never writes over a file that is already there', async () => {
    const data = new TextEncoder().encode('lo que llega ahora');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    vi.stubGlobal('fetch', fakeFetch({ blobs }).impl);
    const dest = join(dir, 'informe.txt');
    writeFileSync(dest, 'lo que ya estaba');

    const first = await getItem(ctxOf(server.client), 'ch1', 'L1', dest);
    const second = await getItem(ctxOf(server.client), 'ch1', 'L1', dest);

    // `zas_get_item(id, dest: "README.md")` from an agent standing in a
    // repository must not destroy the README and report success.
    expect(readFileSync(dest, 'utf8')).toBe('lo que ya estaba');
    expect(first.path).toBe(join(dir, 'informe (1).txt'));
    expect(second.path).toBe(join(dir, 'informe (2).txt'));
    expect(new Uint8Array(readFileSync(first.path!))).toEqual(data);
    expect(new Uint8Array(readFileSync(second.path!))).toEqual(data);
  });

  it('closes the file and clears the temporary when the rename fails', async () => {
    const data = new TextEncoder().encode('escrito, nunca renombrado');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    const landing = join(dir, 'aterrizaje');
    mkdirSync(landing);
    const target = join(landing, 'bajado.txt');
    // The one failure the others cannot reach: everything worked until the last
    // syscall, so the fd was open and the temporary already holds plaintext.
    // The name is chosen before the first chunk is fetched, so a directory grown
    // at it while the download runs is what a destination replaced under the
    // agent's feet looks like — and `renameSync` onto a directory refuses
    // (EPERM on Windows, EISDIR elsewhere). `vi.spyOn(fs, 'renameSync')` cannot
    // do this: vitest cannot redefine an ESM namespace export of `node:fs`.
    const fetcher = fakeFetch({ blobs });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await fetcher.impl(input, init);
      if (!existsSync(target)) mkdirSync(target);
      return answer;
    }));

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1', target))
      .rejects.toMatchObject({ code: 'write_failed' });

    // Nothing was written over the thing standing in the way, and no plaintext
    // survives the failure.
    expect(statSync(target).isDirectory()).toBe(true);
    expect(readdirSync(target)).toEqual([]);
    expect(tmpLeftovers(dir)).toEqual([]);
    // Windows refuses to remove a directory that still holds an open handle, so
    // this is the fd being closed, not a formality.
    rmSync(landing, { recursive: true });
    expect(existsSync(landing)).toBe(false);
  });

  it('falls back to the item id when the manifest name is all dots or empty', async () => {
    for (const name of ['...', '']) {
      const data = new TextEncoder().encode('sin nombre');
      const { manifest, blobs } = await fileItem(data);
      manifest.name = name;
      const server = fakeServer({
        docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
      });
      vi.stubGlobal('fetch', fakeFetch({ blobs }).impl);
      const dest = join(dir, `caida-${name.length}`);
      mkdirSync(dest);

      const out = await getItem(ctxOf(server.client), 'ch1', 'L1', dest);
      expect(out.path).toBe(join(dest, 'L1'));
    }
  });

  it('names a write it could not finish and leaves no plaintext behind', async () => {
    const data = new TextEncoder().encode('nunca llega');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    vi.stubGlobal('fetch', fakeFetch({ blobs }).impl);
    // A regular file where the destination wants a directory: mkdir refuses,
    // and the caller hears a sentence instead of an errno.
    const blocked = join(dir, 'archivo');
    writeFileSync(blocked, 'x');

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1', join(blocked, 'bajado.txt')))
      .rejects.toMatchObject({ code: 'write_failed' });
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('refuses a file manifest whose bytes do not add up to its size', async () => {
    const manifest = newManifest({
      kind: 'file', name: 'vacio.txt', mime: 'text/plain', size: 100,
      created_at: '2026-09-01T10:00:00.000Z', chunks: [],
    });
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    vi.stubGlobal('fetch', fakeFetch().impl);
    const dest = join(dir, 'vacio.txt');

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1', dest)).rejects.toMatchObject({
      code: 'not_found', status: 404,
    });
    expect(existsSync(dest)).toBe(false);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('refuses a file manifest that carries no chunks at all', async () => {
    const manifest = newManifest({
      kind: 'file', name: 'sinbytes.txt', mime: 'text/plain', size: 0,
      created_at: '2026-09-01T10:00:00.000Z', chunks: [],
    });
    // Exactly the shape `openManifest` manufactures for a manifest that arrived
    // without a usable list: no chunks, and no size to catch it either. An
    // empty file handed back as the item is the worse answer.
    delete (manifest as Partial<Manifest>).size;
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    const fetcher = fakeFetch();
    vi.stubGlobal('fetch', fetcher.impl);
    const dest = join(dir, 'sinbytes.txt');

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1', dest)).rejects.toMatchObject({
      code: 'not_found', status: 404,
    });
    expect(fetcher.impl).not.toHaveBeenCalled();
    expect(existsSync(dest)).toBe(false);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('refuses a manifest with more chunks than a download can have', async () => {
    const manifest = newManifest({
      kind: 'file', name: 'enorme.bin', mime: 'application/octet-stream', size: 8193,
      created_at: '2026-09-01T10:00:00.000Z',
      chunks: Array.from({ length: 8193 }, (_, i) => ({
        blob_id: `b${i}`, key: 'k', nonce: 'n', size: 1, cap: `c${i}`,
      })),
    });
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    const fetcher = fakeFetch();
    vi.stubGlobal('fetch', fetcher.impl);

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1', join(dir, 'enorme.bin')))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(fetcher.impl).not.toHaveBeenCalled();
  });

  it('keeps a rate limit and a broken server out of the capability answer', async () => {
    const data = new TextEncoder().encode('hola');
    const { manifest, blobs } = await fileItem(data);
    const docs = [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })];

    const busy = fakeServer({ docs });
    vi.stubGlobal('fetch', fakeFetch({ blobs, redeemStatus: 429 }).impl);
    await expect(getItem(ctxOf(busy.client), 'ch1', 'L1', join(dir, 'a.txt'))).rejects.toMatchObject({
      code: 'rate_limited', status: 429,
    });

    const ill = fakeServer({ docs });
    vi.stubGlobal('fetch', fakeFetch({ blobs, redeemStatus: 503 }).impl);
    await expect(getItem(ctxOf(ill.client), 'ch1', 'L1', join(dir, 'b.txt'))).rejects.toMatchObject({
      code: 'network', status: 503,
    });
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('refuses a fetch without a read grant before it touches the network', async () => {
    const server = fakeServer({ grants: [grant({ read: false })] });

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1')).rejects.toMatchObject({
      code: 'read_forbidden', status: 403,
    });
    expect(server.firestoreRunQuery).not.toHaveBeenCalled();
  });

  it('turns a Firestore permission denial on a fetch into read_forbidden', async () => {
    const server = fakeServer({
      runQuery: async () => { throw new ZasError('http_403', 403); },
    });

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1')).rejects.toMatchObject({
      code: 'read_forbidden', status: 403,
    });
  });

  it('surfaces a refused cap as invalid_cap', async () => {
    const data = new TextEncoder().encode('hola');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    vi.stubGlobal('fetch', fakeFetch({ blobs, redeemStatus: 403 }).impl);

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1', join(dir, 'x.txt'))).rejects.toMatchObject({
      code: 'invalid_cap', status: 403,
    });
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('surfaces a refused blob fetch as invalid_cap', async () => {
    const data = new TextEncoder().encode('hola');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    vi.stubGlobal('fetch', fakeFetch({ blobs, blobStatus: 404 }).impl);

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1', join(dir, 'x.txt'))).rejects.toMatchObject({
      code: 'invalid_cap', status: 403,
    });
    // The chunk it did decrypt must not survive the failure as a stray .tmp.
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('answers not_found for an id the channel does not hold, a tombstone or an unreadable manifest', async () => {
    const gone = fakeServer({ docs: [] });
    await expect(getItem(ctxOf(gone.client), 'ch1', 'L9')).rejects.toMatchObject({
      code: 'not_found', status: 404,
    });

    const burned = fakeServer({ docs: [linkDoc('L1', { bar: { booleanValue: true } })] });
    await expect(getItem(ctxOf(burned.client), 'ch1', 'L1')).rejects.toMatchObject({
      code: 'not_found', status: 404,
    });

    const foreign = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(note('ajena'), otherKey) } })],
    });
    await expect(getItem(ctxOf(foreign.client), 'ch1', 'L1')).rejects.toMatchObject({
      code: 'not_found', status: 404,
    });

    const expired = fakeServer({
      docs: [linkDoc('L1', {
        manifest_enc: { stringValue: sealedOf(note('vencida')) },
        expires_at: { timestampValue: '2026-08-08T10:00:00Z' },
      })],
    });
    await expect(getItem(ctxOf(expired.client), 'ch1', 'L1')).rejects.toMatchObject({
      code: 'not_found', status: 404,
    });
  });

  it('answers not_found for an id that is not one path segment', async () => {
    const server = fakeServer();
    await expect(getItem(ctxOf(server.client), 'ch1', '../../links/L1')).rejects.toMatchObject({
      code: 'not_found', status: 404,
    });
    expect(server.firestoreRunQuery).not.toHaveBeenCalled();
  });

  it('answers not_found for an id Firestore reserves', async () => {
    const server = fakeServer();
    // A caller that read an id off a plain object hands over __proto__ sooner
    // or later. Firestore reserves every __...__ name and answers 400.
    await expect(getItem(ctxOf(server.client), 'ch1', '__proto__')).rejects.toMatchObject({
      code: 'not_found', status: 404,
    });
    expect(server.firestoreRunQuery).not.toHaveBeenCalled();
  });

  it('names a thrown fetch during a download instead of letting it out raw', async () => {
    const data = new TextEncoder().encode('se corta la red');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    const fetcher = fakeFetch({ blobs });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/blobs/redeem')) return fetcher.impl(input, init);
      throw new TypeError('fetch failed');
    }));
    const dest = join(dir, 'cortado.txt');

    const failure = await getItem(ctxOf(server.client), 'ch1', 'L1', dest).catch((err) => err);
    expect(failure).toMatchObject({ code: 'network', status: 0 });
    // The sentence the owner reads is the code's; the message is what a bug
    // report needs, so the original must survive the rename.
    expect((failure as Error).message).toContain('fetch failed');
    expect(existsSync(dest)).toBe(false);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('does not read a thrown error that carries a code as a filesystem failure', async () => {
    const data = new TextEncoder().encode('un error raro');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    const fetcher = fakeFetch({ blobs });
    // `code` is not the filesystem's alone — `ZasError` has one too, and so does
    // this. Only a Node errno shape (`syscall`/`errno`) means the disk.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/blobs/redeem')) return fetcher.impl(input, init);
      throw Object.assign(new Error('raro'), { code: 'weird' });
    }));

    await expect(getItem(ctxOf(server.client), 'ch1', 'L1', join(dir, 'raro.txt')))
      .rejects.toMatchObject({ code: 'network', status: 0 });
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it('removes the private directory it made for a download that failed', async () => {
    const data = new TextEncoder().encode('nunca llega');
    const { manifest, blobs } = await fileItem(data);
    const server = fakeServer({
      docs: [linkDoc('L1', { manifest_enc: { stringValue: sealedOf(manifest) } })],
    });
    vi.stubGlobal('fetch', fakeFetch({ blobs, blobStatus: 404 }).impl);
    // os.tmpdir() reads these at every call, so the directory the download
    // makes for itself lands where the test can look for it.
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    process.env.TMPDIR = dir;
    process.env.TMP = dir;
    process.env.TEMP = dir;
    try {
      await expect(getItem(ctxOf(server.client), 'ch1', 'L1')).rejects.toMatchObject({
        code: 'invalid_cap', status: 403,
      });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    expect(readdirSync(dir).filter((n) => n.startsWith('zas-agent-'))).toEqual([]);
    expect(tmpLeftovers(dir)).toEqual([]);
  });
});
