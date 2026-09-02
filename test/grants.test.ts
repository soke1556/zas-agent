import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64ToBytes, bytesToB64 } from '../src/shared/hash.js';
import { encryptChannelName } from '../src/shared/manifest.js';
import { assignChannelKey, mintChannelKey } from '../src/shared/sharedchannel.js';
import type { ZasClient } from '../src/client.js';
import { channelKeyOf, channelNameOf, grantsFor, refreshGrants, resolveChannel } from '../src/grants.js';
import { defaultEndpoints, loadGrants, newKeyMaterial, saveGrants, type Identity, type RemoteGrant } from '../src/identity.js';

const keys = newKeyMaterial();
const identity: Identity = {
  version: 1, agent_uid: `agent_${'A'.repeat(22)}`, owner_uid: 'owner-1', name: 'CC',
  kind: 'claude_code', host: 'box', ...keys, ...defaultEndpoints(),
};

function grantFor(channelId: string, name: string, over: Partial<RemoteGrant> = {}): RemoteGrant {
  const channelKey = mintChannelKey();
  return {
    channel_id: channelId,
    send: true,
    read: false,
    wrapped_key: bytesToB64(assignChannelKey(b64ToBytes(keys.x25519_public), 1, channelKey)),
    key_version: 1,
    name_enc: bytesToB64(encryptChannelName(channelKey, name, 1)),
    mode: 'edit',
    direct_mode: false,
    ...over,
  };
}

function fakeClient(grants: RemoteGrant[], id: Identity = identity) {
  const api = vi.fn(async () => ({ agent_uid: id.agent_uid, owner_uid: id.owner_uid, grants }));
  return { client: { identity: id, api } as unknown as ZasClient, api };
}

describe('grants', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'zas-grants-')); process.env.ZAS_AGENT_HOME = home; });
  afterEach(() => { delete process.env.ZAS_AGENT_HOME; rmSync(home, { recursive: true, force: true }); });

  it('opens the wrapped key and the channel name with the agent key', () => {
    const grant = grantFor('c1', 'Trabajo');
    const key = channelKeyOf(identity, grant);
    expect(key).toHaveLength(32);
    expect(channelNameOf(identity, grant)).toBe('Trabajo');
  });

  it('resolves by id, by name and by being the only grant', () => {
    const one = grantFor('c1', 'Trabajo');
    const two = grantFor('c2', 'Fotos');
    expect(resolveChannel(identity, [one, two], 'c2')).toBe(two);
    expect(resolveChannel(identity, [one, two], '  trabajo ')).toBe(one);
    expect(resolveChannel(identity, [one], undefined)).toBe(one);
  });

  it('refuses when the name is ambiguous, unknown, or there is nothing to pick', () => {
    const one = grantFor('c1', 'Trabajo');
    const twin = grantFor('c2', 'trabajo');
    expect(() => resolveChannel(identity, [one, twin], 'Trabajo'))
      .toThrowError(expect.objectContaining({ code: 'grant_missing' }));
    expect(() => resolveChannel(identity, [one, twin], undefined))
      .toThrowError(expect.objectContaining({ code: 'grant_missing' }));
    expect(() => resolveChannel(identity, [one], 'Nada'))
      .toThrowError(expect.objectContaining({ code: 'grant_missing' }));
    expect(() => resolveChannel(identity, [], undefined))
      .toThrowError(expect.objectContaining({ code: 'grant_missing' }));
  });

  it('will not name a grant whose envelope does not open, even when the name matches', () => {
    // Sealed for some other agent: the name is right, the key is not this
    // agent's. Without the guard in resolveChannel this grant would be the
    // silent single match and a send would go into someone else's channel.
    const sealed = grantFor('c1', 'Trabajo');
    const envelope = b64ToBytes(sealed.wrapped_key);
    envelope[envelope.length - 1] ^= 0xff;
    const foreign = { ...sealed, wrapped_key: bytesToB64(envelope) };

    expect(() => channelNameOf(identity, foreign)).toThrowError(expect.objectContaining({ code: 'key_stale' }));
    expect(() => resolveChannel(identity, [foreign], 'Trabajo'))
      .toThrowError(expect.objectContaining({ code: 'grant_missing' }));
  });

  it('caches what /agents/me answered and stamps the agent it belongs to', async () => {
    const grants = [grantFor('c1', 'Trabajo')];
    const { client, api } = fakeClient(grants);
    expect(await refreshGrants(client, 'p')).toEqual(grants);
    expect(loadGrants('p')!.agent_uid).toBe(identity.agent_uid);
    expect(await grantsFor(client, 'p')).toEqual(grants);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the cache is older than a minute', async () => {
    const grants = [grantFor('c1', 'Trabajo')];
    const { client, api } = fakeClient(grants);
    saveGrants('p', { fetched_at: Date.now() - 61_000, agent_uid: identity.agent_uid, grants: [] });
    expect(await grantsFor(client, 'p')).toEqual(grants);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('treats a cache written by another agent as stale', async () => {
    const grants = [grantFor('c1', 'Trabajo')];
    const { client, api } = fakeClient(grants);
    saveGrants('p', { fetched_at: Date.now(), agent_uid: `agent_${'B'.repeat(22)}`, grants: [grantFor('old', 'Viejo')] });
    expect(await grantsFor(client, 'p')).toEqual(grants);
    expect(api).toHaveBeenCalledTimes(1);
    expect(loadGrants('p')!.agent_uid).toBe(identity.agent_uid);
  });
});
