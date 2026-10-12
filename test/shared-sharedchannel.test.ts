// The shared-channel key must round-trip through the account-key envelope and
// name its generation, so account rotation keeps working for memberships.
import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { assignChannelKey, channelAssignmentPublicKey, channelWrappedKeyVersion, mintChannelKey, openChannelAssignment, wrapChannelKey, unwrapChannelKey } from '../src/shared/sharedchannel.js';
import { envelopeVersion } from '../src/shared/manifest.js';

const accountKey = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(9);

describe('shared channel key wrap', () => {
  it('opens v2 assignments and authenticates the header, recipient, and ephemeral key', () => {
    const channelKey = mintChannelKey();
    const assigned = assignChannelKey(channelAssignmentPublicKey(accountKey), 4, channelKey, 2);
    expect(channelWrappedKeyVersion(assigned)).toBe(4);
    expect(unwrapChannelKey(accountKey, assigned)).toEqual(channelKey);
    expect(() => unwrapChannelKey(otherKey, assigned)).toThrow();
    for (let i = 0; i < assigned.length; i++) {
      const changed = assigned.slice(); changed[i] ^= 1;
      expect(() => unwrapChannelKey(accountKey, changed)).toThrow();
    }
    expect(() => unwrapChannelKey(accountKey, assigned.slice(0, 20))).toThrow();
    expect(assignChannelKey(channelAssignmentPublicKey(accountKey), 4, channelKey)[2]).toBe(1);
  });
  it('mints 32 random bytes', () => {
    const a = mintChannelKey();
    const b = mintChannelKey();
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('round-trips under the account key and names its generation', () => {
    const ck = mintChannelKey();
    const wrapped = wrapChannelKey(accountKey, 3, ck);
    expect(envelopeVersion(wrapped)).toBe(3);
    expect(Buffer.from(unwrapChannelKey(accountKey, wrapped)).equals(Buffer.from(ck))).toBe(true);
  });

  it('refuses the wrong account key', () => {
    const wrapped = wrapChannelKey(accountKey, 2, mintChannelKey());
    expect(() => unwrapChannelKey(otherKey, wrapped)).toThrow();
  });

  it('assigns a key to another account without its private key', () => {
    const channelKey = mintChannelKey();
    const assigned = assignChannelKey(channelAssignmentPublicKey(accountKey), 4, channelKey);
    expect(channelWrappedKeyVersion(assigned)).toBe(4);
    expect(unwrapChannelKey(accountKey, assigned)).toEqual(channelKey);
    expect(() => unwrapChannelKey(otherKey, assigned)).toThrow();
  });

  it('opens an assignment directly with a raw recipient private key, and refuses a non-assignment envelope', () => {
    const priv = x25519.utils.randomPrivateKey();
    const pub = x25519.getPublicKey(priv);
    const channelKey = mintChannelKey();
    const envelope = assignChannelKey(pub, 5, channelKey);
    expect(openChannelAssignment(priv, envelope)).toEqual(channelKey);
    expect(() => openChannelAssignment(priv, wrapChannelKey(accountKey, 1, channelKey))).toThrow();
  });
});
