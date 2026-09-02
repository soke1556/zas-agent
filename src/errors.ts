// One error vocabulary for the whole package. The server answers with the
// names its own routes grew over time; the agent speaks the closed set from
// the spec, so the rename table is the single place the two meet.
const RENAMES: Record<string, string> = {
  storage_limit: 'quota_exceeded',
  file_too_large: 'file_too_big',
  read_only: 'send_forbidden',
  unknown_channel: 'grant_missing',
  no_account: 'grant_missing',
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

// One sentence per code, es-AR first: the agent prints these to a terminal
// where a stack trace would say nothing about what the owner has to do.
// `{path}` is filled from the error's message.
const SENTENCES: Record<string, { es: string; en: string }> = {
  identity_corrupt: { es: 'El archivo de identidad del agente está dañado: {path}. Restauralo o borralo y volvé a emparejar.', en: 'The agent identity file is damaged: {path}. Restore it, or delete it and pair again.' },
  not_paired: { es: 'Este agente todavía no está emparejado. Corré «npx -y zas-agent pair» en la terminal.', en: 'This agent is not paired yet. Run “npx -y zas-agent pair” in the terminal.' },
  internal: { es: 'Algo falló dentro del agente. Probá de nuevo.', en: 'Something failed inside the agent. Try again.' },
  agent_forbidden: { es: 'Este agente no puede hacer eso; solo el dueño de la cuenta.', en: 'This agent cannot do that; only the account owner can.' },
  agent_revoked: { es: 'El dueño revocó este agente. Volvé a emparejar con «zas-agent pair».', en: 'The owner revoked this agent. Pair again with “zas-agent pair”.' },
  grant_missing: { es: 'Este agente no tiene acceso a ese canal. El dueño lo agrega desde Ajustes → Agentes.', en: 'This agent has no access to that channel. The owner adds it from Settings → Agents.' },
  not_found: { es: 'Ese ítem no está en el canal.', en: 'That item is not in the channel.' },
  invalid_cap: { es: 'Ese archivo ya no está disponible.', en: 'That file is no longer available.' },
  write_failed: { es: 'No se pudo guardar el archivo en el destino.', en: 'The file could not be saved to the destination.' },
  send_forbidden: { es: 'Este agente no puede enviar a ese canal.', en: 'This agent cannot send to that channel.' },
  read_forbidden: { es: 'Este agente no puede leer ese canal.', en: 'This agent cannot read that channel.' },
  direct_mode: { es: 'Ese canal está en modo Directo. Usá zas_send_direct.', en: 'That channel is in Directo mode. Use zas_send_direct.' },
  not_direct_mode: { es: 'Ese canal no está en modo Directo. Usá zas_send_file.', en: 'That channel is not in Directo mode. Use zas_send_file.' },
  key_stale: { es: 'La clave del canal cambió. El dueño la renueva al abrir Zas.', en: 'The channel key changed. The owner refreshes it by opening Zas.' },
  quota_exceeded: { es: 'La cuenta llegó a su límite de almacenamiento.', en: 'The account reached its storage limit.' },
  rate_limited: { es: 'Demasiados envíos seguidos. Esperá un momento.', en: 'Too many sends in a row. Wait a moment.' },
  file_too_big: { es: 'El archivo supera el máximo del plan.', en: 'The file is over the plan limit.' },
  duplicate: { es: 'Ese ítem ya está en el canal.', en: 'That item is already in the channel.' },
  pairing_expired: { es: 'El emparejamiento venció. Corré «zas-agent pair» de nuevo.', en: 'The pairing expired. Run “zas-agent pair” again.' },
  pairing_cancelled: { es: 'El dueño canceló el emparejamiento.', en: 'The owner cancelled the pairing.' },
  feature_disabled: { es: 'Los agentes todavía no están habilitados para esta cuenta.', en: 'Agents are not enabled for this account yet.' },
  upload_failed: { es: 'No se pudo subir el archivo. Probá de nuevo.', en: 'The upload failed. Try again.' },
  oprf_failed: { es: 'Zas no respondió bien al preparar el archivo. Probá de nuevo.', en: 'Zas did not answer correctly while preparing the file. Try again.' },
  network: { es: 'No hay conexión con Zas. Probá de nuevo en un momento.', en: 'Zas cannot be reached. Try again in a moment.' },
  sign_in_failed: { es: 'Zas no aceptó la sesión de este agente. Probá de nuevo o volvé a emparejar.', en: 'Zas did not accept this agent session. Try again, or pair again.' },
  bad_signature: { es: 'Zas rechazó la firma de este agente. Emparejalo de nuevo.', en: "Zas rejected this agent's signature. Pair it again." },
  missing_token: { es: 'Falta el token de sesión. Emparejá el agente de nuevo.', en: 'The session token is missing. Pair the agent again.' },
};

export function humanSentence(error: ZasError, locale: 'es' | 'en' = 'es'): string {
  const sentence = SENTENCES[error.code]?.[locale];
  // A replacer function, not a string: a path is arbitrary text, and `$&` or
  // `$'` in a directory name would otherwise be expanded as a replacement
  // pattern and print a path the owner does not have.
  if (sentence) return sentence.replace('{path}', () => error.message);
  return locale === 'es' ? `Zas respondió ${error.code} (${error.status}).` : `Zas answered ${error.code} (${error.status}).`;
}
