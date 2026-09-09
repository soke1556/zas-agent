// An agent changing what it sent: the re-sealed manifest with the guard and
// the trace flag, and the bytes swap with the old caps released. Driven
// against the fake Firestore of read.test.ts and the fake pipeline of
// send.test.ts, folded into one server: an edit reads before it writes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64ToBytes, bytesToB64 } from '../src/shared/hash.js';
import { encryptChannelName, newManifest, openManifest, sealManifest, type Manifest } from '../src/shared/manifest.js';
import { oprfEvaluate as oprfEvaluateServer, serverKeyFromSeed } from '../src/shared/oprf.js';
import { assignChannelKey, mintChannelKey } from '../src/shared/sharedchannel.js';
import type { ZasClient } from '../src/client.js';
import { editItem, replaceFile } from '../src/edit.js';
import { errorFromResponse } from '../src/errors.js';
import {
  defaultEndpoints, loadFingerprints, newKeyMaterial, saveFingerprints, type Identity, type RemoteGrant,
} from '../src/identity.js';
import type { SendContext } from '../src/send.js';

const SERVER_KEY = serverKeyFromSeed(new Uint8Array(32).fill(7));
const keys = newKeyMaterial();
const identity: Identity = {
  version: 1, agent_uid: `agent_${'A'.repeat(22)}`, owner_uid: 'owner-1', name: 'CC',
  kind: 'claude_code', host: 'box', ...keys, ...defaultEndpoints(),
};
const channelKey = mintChannelKey();
const DOC_ROOT = `projects/${identity.firestore_project}/databases/(default)/documents`;
/** What Firestore REST writes on the row, and what `Date.parse` makes of it. */
const UPDATE_TIME = '2026-09-01T10:00:00.123456Z';
const UPDATE_MS = Date.parse('2026-09-01T10:00:00.123Z');

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

function sealedOf(manifest: Manifest): string {
  return bytesToB64(sealManifest(channelKey, manifest, 1));
}

function note(text: string, over: Partial<Manifest> = {}): Manifest {
  return newManifest({
    kind: 'text', name: 'nota', mime: 'text/plain', size: text.length,
    created_at: '2026-09-01T10:00:00.000Z', text, chunks: [], ...over,
  });
}

const OLD_BLOB = 'a'.repeat(64);

function file(over: Partial<Manifest> = {}): Manifest {
  return newManifest({
    kind: 'file', name: 'informe.txt', mime: 'text/plain', size: 100,
    created_at: '2026-08-30T08:00:00.000Z',
    chunks: [{
      blob_id: OLD_BLOB, key: bytesToB64(new Uint8Array(32)), nonce: bytesToB64(new Uint8Array(24)),
      size: 100, cap: 'old-bound-cap',
    }],
    ...over,
  });
}

/** One `links` document as Firestore REST answers it. `agent` is this agent's
 *  unless the test says whose. */
function linkDoc(id: string, manifest: Manifest, over: { agent?: string | null; updateTime?: string } = {}): unknown {
  const agent = over.agent === undefined ? identity.agent_uid : over.agent;
  return {
    name: `${DOC_ROOT}/accounts/${identity.owner_uid}/channels/ch1/links/${id}`,
    fields: {
      manifest_enc: { stringValue: sealedOf(manifest) },
      ...(agent === null ? {} : { agent: { stringValue: agent } }),
    },
    createTime: '2026-09-01T10:00:00.000000Z',
    updateTime: over.updateTime ?? UPDATE_TIME,
  };
}

interface Patch { path: string; body: Record<string, unknown> }
interface Replace { path: string; body: Record<string, unknown> }

function fakeServer(opts: {
  grants?: RemoteGrant[];
  docs?: unknown[];
  /** The PATCH answers 409 `stale`. */
  patchStale?: boolean;
  /** The replace answers `replayed`. */
  replayed?: boolean;
} = {}) {
  const grants = opts.grants ?? [grant()];
  const patches: Patch[] = [];
  const replaces: Replace[] = [];
  const calls: string[] = [];
  const puts: string[] = [];
  const blobOf = (path: string): string => path.slice('/blobs/'.length, path.lastIndexOf('/'));

  const api = vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/agents/me') {
      return { agent_uid: identity.agent_uid, owner_uid: identity.owner_uid, grants };
    }
    if (method === 'POST' && path === '/blobs/probe') {
      const ids = body!.ids as string[];
      return { results: Object.fromEntries(ids.map((id) => [id, 'upload'])), challenges: {} };
    }
    if (method === 'POST' && path.endsWith('/upload-url')) {
      return { upload_protocol: 1, upload_id: 'u1', url: 'http://put.local/x' };
    }
    if (method === 'POST' && path.endsWith('/commit')) {
      return { cap: `cap-${blobOf(path).slice(0, 8)}` };
    }
    if (method === 'POST' && /^\/links\/[^/]+\/[^/]+\/replace$/.test(path)) {
      replaces.push({ path, body: body! });
      const next = openManifest(channelKey, b64ToBytes(body!.manifest_enc as string));
      return {
        ok: true,
        caps: Object.fromEntries(next.chunks.map((c) => [c.blob_id, `bound-${c.blob_id.slice(0, 8)}`])),
        update_time: UPDATE_MS + 500,
        replaced_at: UPDATE_MS + 400,
        replayed: opts.replayed === true,
      };
    }
    if (method === 'PATCH' && path.startsWith('/links/')) {
      if (opts.patchStale) throw errorFromResponse(409, { error: 'stale' });
      patches.push({ path, body: body! });
      return { ok: true, update_time: UPDATE_MS + 1000 };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  const firestoreRunQuery = vi.fn(async () => opts.docs ?? []);
  const oprfEvaluate = vi.fn(async (blinded: string[]) =>
    blinded.map((b) => bytesToB64(oprfEvaluateServer(SERVER_KEY, b64ToBytes(b)))));
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    puts.push(String(input));
    return new Response(null, { status: 200 });
  });
  const idToken = vi.fn(async () => 'id-token-1');
  const client = { identity, api, firestoreRunQuery, oprfEvaluate, idToken } as unknown as ZasClient;
  return { api, calls, patches, replaces, puts, client, fetchImpl, firestoreRunQuery };
}

const ctxOf = (client: ZasClient): SendContext => ({ identity, client, profile: 'p' });

/** What one PATCH wrote, opened with the channel key. */
function opened(patch: Patch): Manifest {
  return openManifest(channelKey, b64ToBytes(patch.body.manifest_enc as string));
}

const receipt = (linkId: string) => ({ link_id: linkId, bytes: 1, chunks: 0, deduplicated: 0, at: Date.now() });

describe('editItem', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-edit-'));
    process.env.ZAS_AGENT_HOME = home;
  });
  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  });

  it('re-seals a new title with the trace flag and the update time it read', async () => {
    const server = fakeServer({ docs: [linkDoc('L1', note('hola'))] });
    saveFingerprints('p', { entries: { k1: receipt('L1'), k2: receipt('L2') } });

    const out = await editItem(ctxOf(server.client), { id: 'L1', title: 'Saludo' });

    expect(server.patches).toHaveLength(1);
    expect(server.patches[0].path).toBe('/links/ch1/L1');
    expect(server.patches[0].body).toMatchObject({ edit: true, expected_update_time: UPDATE_MS });
    const manifest = opened(server.patches[0]);
    expect(manifest.title).toBe('Saludo');
    expect(manifest.text).toBe('hola');
    expect(out).toEqual({
      link_id: 'L1', channel_id: 'ch1', channel_name: 'Trabajo', kind: 'text', title: 'Saludo',
      update_time: UPDATE_MS + 1000,
    });
    // "Send that again" after an edit makes a new item, not the edited one.
    expect(Object.keys(loadFingerprints('p').entries)).toEqual(['k2']);
  });

  it('changes a note’s text, language and cover, and derives the label from the first line', async () => {
    const server = fakeServer({
      docs: [linkDoc('L1', note('hola', { html: '<p>hola</p>', code: { lang: 'md', auto: true } }))],
    });

    await editItem(ctxOf(server.client), { id: 'L1', text: 'const x = 1;\nconst y = 2;', lang: 'ts', secret: true });

    const manifest = opened(server.patches[0]);
    expect(manifest.text).toBe('const x = 1;\nconst y = 2;');
    expect(manifest.size).toBe(new TextEncoder().encode('const x = 1;\nconst y = 2;').length);
    expect(manifest.name).toBe('const x = 1;');
    expect(manifest.html).toBeUndefined();
    expect(manifest.code).toEqual({ lang: 'ts', auto: false });
    expect(manifest.sensitive).toBe(true);
  });

  it('clears a title with an empty string, and a language and cover the same way', async () => {
    const server = fakeServer({
      docs: [linkDoc('L1', note('hola', { title: 'Viejo', code: { lang: 'ts' }, sensitive: true }))],
    });

    const out = await editItem(ctxOf(server.client), { id: 'L1', title: '', lang: '', secret: false });

    const manifest = opened(server.patches[0]);
    expect(manifest.title).toBeUndefined();
    expect(manifest.code).toBeUndefined();
    expect(manifest.sensitive).toBeUndefined();
    expect(out.title).toBe('nota');
  });

  it('writes nothing when asked to change nothing', async () => {
    const server = fakeServer({ docs: [linkDoc('L1', note('hola', { title: 'Igual' }))] });
    const out = await editItem(ctxOf(server.client), { id: 'L1' });
    expect(server.patches).toHaveLength(0);
    expect(out).toMatchObject({ title: 'Igual', update_time: UPDATE_MS });
  });

  it('refuses a note’s fields on a file, and leaves the title path open', async () => {
    const server = fakeServer({ docs: [linkDoc('L1', file())] });
    await expect(editItem(ctxOf(server.client), { id: 'L1', text: 'x' })).rejects.toMatchObject({ code: 'not_a_note' });
    await expect(editItem(ctxOf(server.client), { id: 'L1', lang: 'ts' })).rejects.toMatchObject({ code: 'not_a_note' });
    expect(server.patches).toHaveLength(0);

    const out = await editItem(ctxOf(server.client), { id: 'L1', title: 'Informe final' });
    expect(opened(server.patches[0]).title).toBe('Informe final');
    expect(out.kind).toBe('file');
  });

  it('refuses an item this agent did not send, before any write', async () => {
    const byPerson = fakeServer({ docs: [linkDoc('L1', note('hola'), { agent: null })] });
    await expect(editItem(ctxOf(byPerson.client), { id: 'L1', title: 'x' })).rejects.toMatchObject({ code: 'not_yours', status: 403 });
    expect(byPerson.patches).toHaveLength(0);

    const byOther = fakeServer({ docs: [linkDoc('L1', note('hola'), { agent: `agent_${'B'.repeat(22)}` })] });
    await expect(editItem(ctxOf(byOther.client), { id: 'L1', title: 'x' })).rejects.toMatchObject({ code: 'not_yours' });
    expect(byOther.patches).toHaveLength(0);
  });

  it('answers stale when the item moved under it, and keeps the receipts', async () => {
    const server = fakeServer({ docs: [linkDoc('L1', note('hola'))], patchStale: true });
    saveFingerprints('p', { entries: { k1: receipt('L1') } });
    await expect(editItem(ctxOf(server.client), { id: 'L1', title: 'x' })).rejects.toMatchObject({ code: 'stale', status: 409 });
    expect(Object.keys(loadFingerprints('p').entries)).toEqual(['k1']);
  });

  it('needs a grant that reads and sends, off Directo', async () => {
    const cases: [Partial<RemoteGrant>, string][] = [
      [{ read: false }, 'read_forbidden'],
      [{ send: false }, 'send_forbidden'],
      [{ mode: 'view', send: false }, 'send_forbidden'],
      [{ direct_mode: true }, 'direct_mode'],
    ];
    for (const [over, code] of cases) {
      const server = fakeServer({ grants: [grant(over)], docs: [linkDoc('L1', note('hola'))] });
      // Grants are cached per profile: one profile per case.
      const ctx: SendContext = { identity, client: server.client, profile: `p-${code}-${String(over.read)}${String(over.send)}` };
      await expect(editItem(ctx, { id: 'L1', title: 'x' })).rejects.toMatchObject({ code });
      expect(server.patches, code).toHaveLength(0);
    }
  });

  it('answers not_found for an item that is not there, or not this agent’s to read', async () => {
    const server = fakeServer({ docs: [] });
    await expect(editItem(ctxOf(server.client), { id: 'L1', title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('replaceFile', () => {
  let home = '';
  let dir = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-edit-'));
    dir = mkdtempSync(join(tmpdir(), 'zas-edit-files-'));
    process.env.ZAS_AGENT_HOME = home;
  });
  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it('places the new bytes, releases the old caps, and seals the bound ones in without a trace', async () => {
    const server = fakeServer({ docs: [linkDoc('L1', file({ title: 'Informe' }))] });
    vi.stubGlobal('fetch', server.fetchImpl);
    saveFingerprints('p', { entries: { k1: receipt('L1'), k2: receipt('L2') } });
    const path = write('informe-v2.txt', 'segunda versión del informe');

    const phases: string[] = [];
    const out = await replaceFile(ctxOf(server.client), { id: 'L1', path }, (p) => phases.push(p));

    expect(phases).toEqual(['hashing', 'encrypting', 'uploading', 'finishing']);
    expect(server.puts).toHaveLength(1);
    expect(server.replaces).toHaveLength(1);
    const { path: replacePath, body } = server.replaces[0];
    expect(replacePath).toBe('/links/ch1/L1/replace');
    expect(body.release).toEqual(['old-bound-cap']);
    expect(body.expected_update_time).toBe(UPDATE_MS);
    expect(typeof body.idempotency_key).toBe('string');
    const posted = openManifest(channelKey, b64ToBytes(body.manifest_enc as string));
    expect(posted.chunks).toHaveLength(1);
    expect(posted.chunks[0].blob_id).not.toBe(OLD_BLOB);
    expect(body.caps).toEqual([`cap-${posted.chunks[0].blob_id.slice(0, 8)}`]);
    // The item's own facts survive; the file's are the new file's.
    expect(posted.name).toBe('informe-v2.txt');
    expect(posted.title).toBe('Informe');
    expect(posted.created_at).toBe('2026-08-30T08:00:00.000Z');
    expect(posted.size).toBe(new TextEncoder().encode('segunda versión del informe').length);

    // The bound caps go in with a plain PATCH: no `edit`, no second row.
    expect(server.patches).toHaveLength(1);
    expect(server.patches[0].body.edit).toBeUndefined();
    const bound = opened(server.patches[0]);
    expect(bound.chunks[0].cap).toBe(`bound-${posted.chunks[0].blob_id.slice(0, 8)}`);

    expect(out).toEqual({
      link_id: 'L1', channel_id: 'ch1', channel_name: 'Trabajo',
      bytes: posted.size, chunks: 1, deduplicated: 0, replayed: false,
    });
    expect(Object.keys(loadFingerprints('p').entries)).toEqual(['k2']);
  });

  it('takes a new title when given one', async () => {
    const server = fakeServer({ docs: [linkDoc('L1', file({ title: 'Informe' }))] });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('otro.txt', 'otro');
    await replaceFile(ctxOf(server.client), { id: 'L1', path, title: 'Informe v2' });
    const posted = openManifest(channelKey, b64ToBytes(server.replaces[0].body.manifest_enc as string));
    expect(posted.title).toBe('Informe v2');
    expect(server.replaces[0].body.idempotency_key).not.toBe('');
  });

  it('refuses a note, somebody else’s file, and a path it cannot use, before any upload', async () => {
    const onNote = fakeServer({ docs: [linkDoc('L1', note('hola'))] });
    vi.stubGlobal('fetch', onNote.fetchImpl);
    const path = write('x.txt', 'x');
    await expect(replaceFile(ctxOf(onNote.client), { id: 'L1', path })).rejects.toMatchObject({ code: 'not_a_file' });
    expect(onNote.puts).toHaveLength(0);
    expect(onNote.replaces).toHaveLength(0);

    const foreign = fakeServer({ docs: [linkDoc('L1', file(), { agent: null })] });
    await expect(replaceFile(ctxOf(foreign.client), { id: 'L1', path })).rejects.toMatchObject({ code: 'not_yours' });
    expect(foreign.calls.filter((c) => c.startsWith('POST /blobs'))).toHaveLength(0);

    const missing = fakeServer({ docs: [linkDoc('L1', file())] });
    await expect(replaceFile(ctxOf(missing.client), { id: 'L1', path: join(dir, 'no-existe.bin') }))
      .rejects.toMatchObject({ code: 'upload_failed', status: 400 });
    expect(missing.api).not.toHaveBeenCalled();
  });

  it('carries the server’s replayed answer through', async () => {
    const server = fakeServer({ docs: [linkDoc('L1', file())], replayed: true });
    vi.stubGlobal('fetch', server.fetchImpl);
    const path = write('x.txt', 'x');
    const out = await replaceFile(ctxOf(server.client), { id: 'L1', path });
    expect(out.replayed).toBe(true);
  });
});
