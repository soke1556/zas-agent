// Key hierarchy.
//
// The account master key is derived from a secret held by the key service and
// the account's own id — not from anything the user has to remember. That is a
// deliberate trade: a recovery phrase would keep the key entirely on the
// client, but it also meant a second device could not read the first device's
// items without the user transcribing twelve words. The separate-service and
// operator boundary of this choice is documented in the public privacy copy.
//
// master key --HKDF--> channel keys --> channel names and link manifests.

import { hkdf512 } from './hash.js';
import { HKDF_INFO_CHANNEL_PREFIX } from './constants.js';

/** `f` comes from the key service, which derives it from the *verified* account
 *  id. Same account, same key, on every device, with nothing to carry across. */
export function accountKeyFromF(f: Uint8Array): Uint8Array {
  return hkdf512(f, 'zas-account-key-v1', 32);
}

export function channelKey(masterKey: Uint8Array, channelId: string): Uint8Array {
  return hkdf512(masterKey, HKDF_INFO_CHANNEL_PREFIX + channelId, 32);
}
