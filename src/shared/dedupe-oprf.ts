import { b64ToBytes, bytesToB64 } from './hash.js';
import { oprfBlind } from './oprf.js';
import { voprfBlind, voprfVerify } from './voprf.js';

export type DedupePolicy = { mode: 0 } | { mode: 1; keyId: string; publicKey: Uint8Array };
export interface DedupeCapability { mode: 0 | 1; key_id?: string }

export function configuredDedupePolicy(capability: DedupeCapability | undefined, pinsJson: string | undefined): DedupePolicy {
  if (capability === undefined || capability.mode === 0) return { mode: 0 };
  try { return dedupePolicy(capability, JSON.parse(pinsJson || '{}')); }
  catch { throw new Error('invalid_voprf_configuration'); }
}

/** Capability comes from the API deployment; public keys come from the client
 * build/configuration, never from the OPRF service's response. */
export function dedupePolicy(capability: DedupeCapability | undefined, pinnedKeys: Record<string, string>): DedupePolicy {
  if (capability === undefined || capability.mode === 0) return { mode: 0 };
  if (capability.mode !== 1 || !capability.key_id || !Object.hasOwn(pinnedKeys, capability.key_id)) throw new Error('invalid_voprf_configuration');
  const publicKey = b64ToBytes(pinnedKeys[capability.key_id]);
  if (publicKey.length !== 32 || publicKey.every((b) => b === 0)) throw new Error('invalid_voprf_configuration');
  return { mode: 1, keyId: capability.key_id, publicKey };
}
export const blindDedupe = (input: Uint8Array, policy: DedupePolicy) => policy.mode === 1 ? voprfBlind(input) : oprfBlind(input);
export function dedupeRequest(blinded: Uint8Array[], policy: DedupePolicy) {
  return { blinded: blinded.map(bytesToB64), ...(policy.mode === 1 ? { mode: 1, key_id: policy.keyId } : {}) };
}
export function verifiedDedupeResponse(raw: unknown, blinded: Uint8Array[], policy: DedupePolicy): Uint8Array[] {
  try {
    const response = raw as { evaluated?: string[]; proof?: string; key_id?: string; mode?: number };
    if (!Array.isArray(response?.evaluated) || response.evaluated.length !== blinded.length) throw new Error();
    const evaluated = response.evaluated.map(b64ToBytes);
    if (policy.mode === 1 && (response.mode !== 1 || response.key_id !== policy.keyId || typeof response.proof !== 'string'
      || !voprfVerify(policy.publicKey, blinded, evaluated, b64ToBytes(response.proof)))) throw new Error();
    return evaluated;
  } catch { throw new Error(policy.mode === 1 ? 'invalid_voprf_proof' : 'invalid_oprf_response'); }
}
