// What the agent is allowed to touch, and how it opens what it is allowed to
// touch. `GET /v1/agents/me` is the only authority; everything here is either
// that answer, a short-lived cache of it, or the two decryptions it enables.
import { b64ToBytes } from './shared/hash.js';
import { decryptChannelName } from './shared/manifest.js';
import { openChannelAssignment } from './shared/sharedchannel.js';
import type { ZasClient } from './client.js';
import { ZasError } from './errors.js';
import { loadGrants, saveGrants, type Identity, type RemoteGrant } from './identity.js';

/** Long enough that a batch of sends costs one round trip, short enough that a
 *  grant the owner just revoked stops working while they are still looking at
 *  the screen. The server refuses on its own either way; this only decides how
 *  fast the agent stops asking. */
export const GRANTS_MAX_AGE_MS = 60_000;

export async function refreshGrants(client: ZasClient, profile: string): Promise<RemoteGrant[]> {
  const me = await client.api<{ grants?: RemoteGrant[] }>('GET', '/agents/me');
  const grants = Array.isArray(me.grants) ? me.grants : [];
  saveGrants(profile, { fetched_at: Date.now(), agent_uid: client.identity.agent_uid, grants });
  return grants;
}

export async function grantsFor(
  client: ZasClient,
  profile: string,
  maxAgeMs: number = GRANTS_MAX_AGE_MS,
): Promise<RemoteGrant[]> {
  const cached = loadGrants(profile);
  const fresh = cached
    && cached.agent_uid === client.identity.agent_uid
    && Array.isArray(cached.grants)
    && Date.now() - cached.fetched_at < maxAgeMs;
  return fresh ? cached!.grants : refreshGrants(client, profile);
}

/** The channel key, unwrapped with the agent's own X25519 key. A grant whose
 *  envelope will not open is one the owner sealed for a different agent, or
 *  under a generation this agent never got — `key_stale` either way, and the
 *  cure is the same: the owner opens Zas and the grant is written again. */
export function channelKeyOf(identity: Identity, grant: RemoteGrant): Uint8Array {
  try {
    return openChannelAssignment(b64ToBytes(identity.x25519_private), b64ToBytes(grant.wrapped_key));
  } catch {
    throw new ZasError('key_stale', 0);
  }
}

export function channelNameOf(identity: Identity, grant: RemoteGrant): string {
  try {
    return decryptChannelName(channelKeyOf(identity, grant), b64ToBytes(grant.name_enc));
  } catch (err) {
    if (err instanceof ZasError) throw err;
    throw new ZasError('key_stale', 0);
  }
}

const fold = (value: string): string => value.trim().toLowerCase();

/** Which channel the caller meant. An id wins outright; a name has to be the
 *  only one that matches, because sending someone's work into the wrong
 *  channel is not a mistake a retry undoes. With nothing named at all, a single
 *  grant is unambiguous and anything else is a question the agent cannot answer
 *  on its own. */
export function resolveChannel(
  identity: Identity,
  grants: RemoteGrant[],
  channel: string | undefined,
): RemoteGrant {
  if (channel === undefined || fold(channel) === '') {
    if (grants.length === 1) return grants[0];
    throw new ZasError('grant_missing', 0);
  }
  const wanted = channel.trim();
  const byId = grants.find((g) => g.channel_id === wanted);
  if (byId) return byId;
  const folded = fold(wanted);
  const byName = grants.filter((g) => {
    try {
      return fold(channelNameOf(identity, g)) === folded;
    } catch {
      // A grant this agent cannot open is a grant it cannot name. It must not
      // become the silent single match for someone else's channel.
      return false;
    }
  });
  if (byName.length === 1) return byName[0];
  throw new ZasError('grant_missing', 0);
}
