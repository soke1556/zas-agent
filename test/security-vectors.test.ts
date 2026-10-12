import { describe, expect, it } from 'vitest';
import vectors from './fixtures/security-protocol-v2.json' with { type: 'json' };
import { openManifest, envelopeVersion } from '../src/shared/manifest.js';
import { openChannelAssignment, channelWrappedKeyVersion } from '../src/shared/sharedchannel.js';

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
describe('pinned web interoperability vectors', () => {
  it('opens headerless, generation-2 v1 and authenticated v2 items', () => {
    const v = vectors.envelope;
    for (const sealed of [v.headerless, v.itemV1, v.itemV2]) {
      expect(openManifest(bytes(v.channelKey), bytes(sealed))).toEqual(JSON.parse(v.plaintext));
    }
    expect(envelopeVersion(bytes(v.itemV1))).toBe(2);
    expect(envelopeVersion(bytes(v.itemV2))).toBe(2);
  });
  it('opens both channel assignment formats with the agent private key', () => {
    const v = vectors.envelope;
    for (const sealed of [v.assignmentV1, v.assignmentV2]) {
      expect(channelWrappedKeyVersion(bytes(sealed))).toBe(2);
      expect(openChannelAssignment(bytes(v.assignmentPrivateKey), bytes(sealed))).toEqual(bytes(v.channelKey));
    }
  });
});
