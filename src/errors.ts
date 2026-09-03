// One error vocabulary for the whole package. The server answers with the
// names its own routes grew over time; the agent speaks the closed set from
// the spec, so the rename table is the single place the two meet.
const RENAMES: Record<string, string> = {
  storage_limit: 'quota_exceeded',
  file_too_large: 'file_too_big',
  read_only: 'send_forbidden',
  unknown_channel: 'grant_missing',
  no_account: 'grant_missing',
  // The Directo routes' words. `not_live` is an exchange that ended under the
  // agent (expired, or cancelled from the receiving side); `direct_too_big`
  // is the plan's Directo ceiling.
  not_live: 'direct_cancelled',
  direct_too_big: 'file_too_big',
};

export class ZasError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
    public readonly retryAfterMs?: number,
    /** The word the server used, kept when `code` had to be collapsed. Two
     *  retries in the send pipeline turn on it — `proof_failed` and
     *  `commit_pending` both arrive as `upload_failed` — and nothing else may
     *  branch on it: it is the server's vocabulary, not the agent's. */
    public readonly serverCode?: string,
  ) {
    super(message ?? code);
    this.name = 'ZasError';
  }
}

/** What the sign-in, pairing and gate routes answer with. They are in the
 *  canonical closed set (shared/src/agent.ts) and must not be collapsed:
 *  `bad_signature` would otherwise reach the owner as "the upload failed" the
 *  day the challenge format changes. The rule the package holds to, and that
 *  `errors.test.ts` enforces both ways: every code in this set, and every code
 *  the package itself constructs, has a `SENTENCES` row. Anything else is
 *  collapsed by `errorFromResponse` before it can reach a terminal. */
export const SIGN_IN_CODES = new Set([
  'bad_signature', 'rate_limited', 'feature_disabled', 'missing_token', 'agent_revoked',
  'agent_forbidden',
]);

export function errorFromResponse(status: number, body: unknown): ZasError {
  const fields = (body && typeof body === 'object' ? body : {}) as { error?: unknown; retry_after_ms?: unknown };
  const raw = typeof fields.error === 'string' ? fields.error : `http_${status}`;
  const retryAfterMs = typeof fields.retry_after_ms === 'number' && Number.isFinite(fields.retry_after_ms)
    ? fields.retry_after_ms
    : undefined;
  const renamed = RENAMES[raw] ?? raw;
  // The closed set is exactly what has a sentence. Anything else is a word
  // from a route the agent does not model — `bad_ids`, `unclaimed_blob`,
  // `not_uploaded` — and letting it through would print a raw server string at
  // a terminal. It collapses instead: the request's own fault below 500, the
  // connection's above. The word survives in `serverCode` and in the message,
  // so a retry can still recognise it and a bug report can still name it.
  const known = Object.prototype.hasOwnProperty.call(SENTENCES, renamed) || SIGN_IN_CODES.has(renamed);
  const code = known ? renamed : (status < 500 ? 'upload_failed' : 'network');
  return new ZasError(code, status, raw, retryAfterMs, raw);
}

// One sentence per code, in English: the agent prints these to a terminal
// where a stack trace would say nothing about what the owner has to do.
// `{path}` is filled from the error's message.
const SENTENCES: Record<string, string> = {
  identity_corrupt: 'The agent identity file is damaged: {path}. Restore it, or delete it and pair again.',
  not_paired: 'This agent is not paired yet. Run “npx -y zas-agent pair” in the terminal.',
  internal: 'Something failed inside the agent. Try again.',
  agent_forbidden: 'This agent cannot do that; only the account owner can.',
  agent_revoked: 'The owner revoked this agent. Pair again with “zas-agent pair”.',
  grant_missing: 'This agent has no access to that channel. The owner adds it from Settings → Agents.',
  not_found: 'That item is not in the channel.',
  invalid_cap: 'That file is no longer available.',
  write_failed: 'The file could not be saved to the destination.',
  send_forbidden: 'This agent cannot send to that channel.',
  read_forbidden: 'This agent cannot read that channel.',
  direct_mode: 'That channel is in Directo mode. Use zas_send_direct.',
  not_direct_mode: 'That channel is not in Directo mode. Use zas_send_file.',
  not_claimed: 'Nobody received the file within ten minutes. The offer was withdrawn.',
  no_offer: 'Nobody offered a file through Directo while this call waited. Ask the owner to press Send Direct, then call again.',
  offer_taken: 'Another device received that file first.',
  direct_cancelled: 'The offer was cancelled from the other side.',
  direct_failed: 'The Directo transfer failed ({path}). Ask the owner before you use zas_send_direct_fallback or zas_receive_direct_fallback.',
  direct_not_failed: 'That job is not a Directo transfer that failed in flight.',
  file_changed: 'The file changed since the Directo offer. Send it again.',
  webrtc_unavailable: 'The WebRTC engine (node-datachannel) could not be loaded on this machine.',
  fallback_unavailable: 'Reliable delivery is not available right now. Try again later.',
  key_stale: 'The channel key changed. The owner refreshes it by opening Zas.',
  quota_exceeded: 'The account reached its storage limit.',
  rate_limited: 'Too many sends in a row. Wait a moment.',
  file_too_big: 'The file is over the plan limit.',
  duplicate: 'That item is already in the channel.',
  pairing_expired: 'The pairing expired. Run “zas-agent pair” again.',
  pairing_cancelled: 'The owner cancelled the pairing.',
  claim_mismatch: 'The code does not match. Try again.',
  pairing_not_approved: 'Nobody has approved this pairing yet.',
  pairing_claimed: 'This pairing was already claimed. Pair again with “zas-agent pair”.',
  agent_limit: 'The account cannot take another agent. The owner deletes one from Settings → Agents.',
  grant_limit: 'The plan allows fewer channels per agent than this pairing grants.',
  feature_disabled: 'Agents are not enabled for this account yet.',
  upload_failed: 'The upload failed. Try again.',
  oprf_failed: 'Zas did not answer correctly while preparing the file. Try again.',
  network: 'Zas cannot be reached. Try again in a moment.',
  sign_in_failed: 'Zas did not accept this agent session. Try again, or pair again.',
  bad_signature: "Zas rejected this agent's signature. Pair it again.",
  missing_token: 'The session token is missing. Pair the agent again.',
};

export function humanSentence(error: ZasError): string {
  const sentence = SENTENCES[error.code];
  // A replacer function, not a string: a path is arbitrary text, and `$&` or
  // `$'` in a directory name would otherwise be expanded as a replacement
  // pattern and print a path the owner does not have.
  if (sentence) return sentence.replace('{path}', () => error.message);
  return `Zas answered ${error.code} (${error.status}).`;
}
