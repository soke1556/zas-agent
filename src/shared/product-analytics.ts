/**
 * Product analytics has one vocabulary on every surface.
 *
 * Event names and properties are deliberately closed. A caller may pass a
 * wider object, but only a named property with a valid number, boolean, or
 * closed string value leaves the process. This is the last guard against a
 * filename, channel name, URL, or raw error message reaching analytics.
 */

export const POSTHOG_PROJECT_TOKEN = 'phc_kpUS3fv9Rhe9KJ5BcFt36mn5w7iyJHCfCfuuRaRutQw2';
export const POSTHOG_INGEST_HOST = 'https://t.zas.red';
export const POSTHOG_UI_HOST = 'https://us.posthog.com';

export const PRODUCT_EVENTS = [
  'account_created',
  'item.created',
  'item.downloaded',
  'item.copied',
  'item.shared',
  'item.pinned',
  'item.unpinned',
  'item.deleted',
  'item.departed',
  'channel_shared',
  'channel_mode_set',
  'invite_created',
  'invite_link_copied',
  'invite_qr_shown',
  'invite_system_sheet_opened',
  'invite_joined',
  'invite_converted',
  'channel.invite_preview',
  'channel.invite_accept',
  'channel.invite_signin',
  'enterprise.invite_preview',
  'enterprise.invite_identity',
  'enterprise.invite_signin',
  'enterprise.invite_account_switch',
  'enterprise.invite_attach',
  'enterprise.invite_accept',
  'enterprise.invite_admin',
  'enterprise.workspace_opened',
  'enterprise.workspace_switched',
  'enterprise.channel_created',
  'enterprise.channel_members_added',
  'share_link_copied',
  'share_qr_shown',
  'share_system_sheet_opened',
  'share_opened',
  'share_content_copied',
  'share_downloaded',
  'share_signin_click',
  'share.saved',
  'share_bar_on',
  'share_bar_off',
  'upload.phase_timing',
  'auth.signin_started',
  'auth.signin_result',
  'auth.session_started',
  'auth.signed_out',
  'auth.session_lost',
  'auth.token_refresh_failed',
  'account_switch.started',
  'account_switch.completed',
  'account_switch.failed',
  'bootstrap.result',
  'direct_mode_set',
  'direct.offered',
  'direct.claimed',
  'direct.connected',
  'direct.completed',
  'direct.received',
  'direct.failed',
  'direct.fallback_started',
  'direct.fallback_ready',
  'direct.fallback_received',
  'direct.fallback_failed',
  'direct.fallback_aborted',
  'direct.too_big',
  'agent.pair_opened',
  'agent.pair_approved',
  'agent.pair_refused',
  'agent.paired',
  'agent.revoked',
  'agent.send',
  'agent.tool_call',
] as const;

export type ProductEvent = (typeof PRODUCT_EVENTS)[number];
export const SERVER_OWNED_PRODUCT_EVENTS = [
  'account_created',
  'item.departed',
  'invite_created',
  'invite_joined',
  'invite_converted',
  'share_opened',
  'share_content_copied',
  'share_downloaded',
  'share_signin_click',
  'agent.send',
  'agent.tool_call',
] as const satisfies readonly ProductEvent[];

export type ServerProductEvent = (typeof SERVER_OWNED_PRODUCT_EVENTS)[number];
export type ClientProductEvent = Exclude<ProductEvent, ServerProductEvent>;

const SERVER_OWNED_PRODUCT_EVENT_SET = new Set<ProductEvent>(SERVER_OWNED_PRODUCT_EVENTS);
export const CLIENT_PRODUCT_EVENTS = PRODUCT_EVENTS.filter(
  (event): event is ClientProductEvent => !SERVER_OWNED_PRODUCT_EVENT_SET.has(event),
);
export type AnalyticsScalar = string | number | boolean;
export type AnalyticsProperties = Record<string, AnalyticsScalar>;

type Rule =
  | { type: 'boolean' }
  | { type: 'number'; min?: number }
  | { type: 'string'; values: ReadonlySet<string> };

const bool: Rule = { type: 'boolean' };
const count: Rule = { type: 'number', min: 0 };
const oneOf = (...values: string[]): Rule => ({ type: 'string', values: new Set(values) });

const sizeBucket = oneOf('lt_1mb', '1_10mb', '10_100mb', '100_512mb', '512mb_5gb', 'gt_5gb');
const itemKind = oneOf('file', 'text');
const itemKindOrUnknown = oneOf('file', 'text', 'unknown');
const role = oneOf('sender', 'receiver');
const candidateType = oneOf('', 'host', 'srflx', 'relay', 'prflx', 'other');
const enterpriseRole = oneOf('owner', 'admin', 'billing_admin', 'member', 'guest');
const agentKind = oneOf('claude_code', 'codex', 'other');
/** Which half of the pairing handoff the person ended on. `unknown` is a
 *  protocol-1 pairing, where the code was always typed. */
const pairHandoff = oneOf('loopback', 'manual', 'unknown');

/** The eleven MCP tools, without their `zas_` prefix. The agent package holds
 *  its registered tools against this list, so a tool added there and not here
 *  fails a test instead of arriving as a property nobody kept. */
export const AGENT_TOOL_NAMES = [
  'status', 'pair', 'send_file', 'send_note', 'send_direct', 'send_direct_fallback',
  'receive_direct', 'receive_direct_fallback', 'list_items', 'get_item', 'jobs',
] as const;

/** The agent's closed error vocabulary (`SENTENCES` in `agent/src/errors.ts`),
 *  plus `none` for a call that worked and `other` for anything outside the
 *  set. It lives here because a property value has to be a closed list before
 *  it reaches PostHog, and shared cannot import the agent package. */
export const AGENT_ERROR_CODES = [
  'none', 'other',
  'identity_corrupt', 'not_paired', 'internal', 'agent_forbidden', 'agent_revoked',
  'grant_missing', 'not_found', 'invalid_cap', 'write_failed', 'send_forbidden',
  'read_forbidden', 'direct_mode', 'not_direct_mode', 'not_claimed', 'no_offer',
  'offer_taken', 'direct_cancelled', 'direct_failed', 'direct_not_failed',
  'file_changed', 'webrtc_unavailable', 'fallback_unavailable', 'key_stale',
  'quota_exceeded', 'rate_limited', 'file_too_big', 'duplicate', 'pairing_expired',
  'pairing_cancelled', 'claim_mismatch', 'pairing_not_approved', 'pairing_claimed',
  'agent_limit', 'grant_limit', 'feature_disabled', 'upload_failed', 'oprf_failed',
  'network', 'sign_in_failed', 'bad_signature', 'missing_token',
] as const;

/** How long a tool call took, as the four buckets `agent.tool_call` documents.
 *  A duration in milliseconds would be a fine number and a poor property: it
 *  is one more digit of a person's working day than the question needs. */
export function agentDurationBucket(ms: number): string {
  if (ms < 1_000) return 'lt_1s';
  if (ms < 10_000) return '1_10s';
  if (ms < 60_000) return '10_60s';
  return 'gt_60s';
}

const EVENT_PROPERTY_RULES: Record<ProductEvent, Readonly<Record<string, Rule>>> = {
  account_created: {},
  'item.created': { kind: itemKind, size_bytes: count, size_bucket: sizeBucket },
  'item.downloaded': { size_bytes: count, size_bucket: sizeBucket },
  'item.copied': {},
  'item.shared': { kind: itemKind },
  'item.pinned': { age_ms: count },
  'item.unpinned': {},
  'item.deleted': { age_ms: count, was_pinned: bool, kind: itemKindOrUnknown },
  'item.departed': {},
  channel_shared: {},
  channel_mode_set: { mode: oneOf('edit', 'view') },
  invite_created: {},
  invite_link_copied: {},
  invite_qr_shown: {},
  invite_system_sheet_opened: {},
  invite_joined: {},
  invite_converted: {},
  'channel.invite_preview': {
    outcome: oneOf('ready', 'unavailable', 'missing_key'),
    signed_in: bool,
  },
  'channel.invite_accept': {
    outcome: oneOf('started', 'completed', 'already_member', 'unavailable', 'failed'),
  },
  'channel.invite_signin': {
    stage: oneOf('link_requested', 'link_sent', 'link_completed', 'failed'),
  },
  'enterprise.invite_preview': {
    outcome: oneOf('pending', 'resumable', 'unavailable'),
    role: enterpriseRole,
  },
  'enterprise.invite_identity': {
    outcome: oneOf('matched', 'mismatched', 'unavailable', 'failed'),
  },
  'enterprise.invite_signin': {
    stage: oneOf('link_requested', 'link_sent', 'link_completed', 'failed'),
  },
  'enterprise.invite_account_switch': { stage: oneOf('started', 'completed', 'failed') },
  'enterprise.invite_attach': {
    stage: oneOf('link_requested', 'link_sent', 'verify_started', 'completed', 'address_taken', 'link_invalid', 'failed'),
  },
  'enterprise.invite_accept': {
    outcome: oneOf('started', 'completed', 'recovered', 'timeout', 'unavailable', 'email_mismatch', 'seat_limit', 'failed'),
    role: enterpriseRole,
    destination: oneOf('workspace', 'admin_console'),
    duration_ms: count,
  },
  'enterprise.invite_admin': {
    outcome: oneOf('created', 'email_sent', 'email_failed', 'reissued', 'revoked'),
    role: enterpriseRole,
    external: bool,
  },
  'enterprise.workspace_opened': { role: enterpriseRole, first_visit: bool },
  'enterprise.workspace_switched': { destination: oneOf('personal', 'organization'), role: enterpriseRole },
  'enterprise.channel_created': { member_count: count },
  'enterprise.channel_members_added': { member_count: count },
  share_link_copied: {},
  share_qr_shown: {},
  share_system_sheet_opened: {},
  share_opened: {},
  share_content_copied: {},
  share_downloaded: {},
  share_signin_click: {},
  'share.saved': {},
  share_bar_on: {},
  share_bar_off: {},
  'upload.phase_timing': {
    stage: oneOf('staging', 'bootstrap', 'thumbnail', 'encrypting', 'uploading', 'finishing'),
    duration_ms: count,
    size_bucket: sizeBucket,
    outcome: oneOf('success', 'failure', 'cancelled'),
    attempt: { type: 'number', min: 1 },
  },
  'auth.signin_started': { provider: oneOf('google.com', 'apple.com') },
  'auth.signin_result': {
    provider: oneOf('google.com', 'apple.com'),
    outcome: oneOf('signed_in', 'cancelled', 'taken', 'failed', 'needs_link'),
    flow: oneOf('signin', 'link', 'connect'),
  },
  'account_switch.started': { operation: oneOf('remember', 'switch'), provider: oneOf('google.com', 'apple.com', 'email_link', 'qr', 'code') },
  'account_switch.completed': { operation: oneOf('remember', 'switch'), provider: oneOf('google.com', 'apple.com', 'email_link', 'qr', 'code') },
  'account_switch.failed': { operation: oneOf('remember', 'switch'), provider: oneOf('google.com', 'apple.com', 'email_link', 'qr', 'code') },
  'auth.session_started': { cold: bool },
  'auth.signed_out': { reason: oneOf('user', 'account_switch', 'abandoned_new_account', 'account_deleted') },
  'auth.session_lost': { session_age_ms: count, foreground: bool },
  'auth.token_refresh_failed': {
    code: oneOf('network', 'token_invalid', 'user_disabled', 'user_missing', 'rate_limited', 'internal', 'unknown'),
  },
  'bootstrap.result': {
    outcome: oneOf('offline', 'ok', 'timeout_warm', 'timeout', 'failed_warm', 'failed'),
    stage: oneOf('cached', 'done', 'unknown', 'keyring', 'account_init', 'listeners'),
    duration_ms: count,
    fault: oneOf('intercepted', 'offline', 'unknown'),
  },
  direct_mode_set: { on: bool },
  'direct.offered': { size_bucket: sizeBucket },
  // `via_agent`: the offer came from a paired agent's process, not from one
  // of the person's devices. The claim and the two receiver outcomes carry it.
  'direct.claimed': { size_bucket: sizeBucket, via_agent: bool },
  'direct.connected': { role, ms: count },
  'direct.completed': {
    via: oneOf('lan', 'wan', 'relay', 'unknown'),
    pair_local: candidateType,
    pair_remote: candidateType,
    connect_ms: count,
    duration_ms: count,
    size_bucket: sizeBucket,
    turn_urls_supplied: count,
    turn_urls_configured: count,
    restarts: count,
  },
  'direct.received': {
    via_agent: bool,
    via: oneOf('lan', 'wan', 'relay', 'unknown'),
    pair_local: candidateType,
    pair_remote: candidateType,
    connect_ms: count,
    duration_ms: count,
    size_bucket: sizeBucket,
    turn_urls_supplied: count,
    turn_urls_configured: count,
    restarts: count,
  },
  'direct.failed': {
    role,
    via_agent: bool,
    reason: oneOf(
      'peer_silent',
      'connect_timeout',
      'ice_failed',
      'disconnected',
      'peer_closed',
      'peer_abort',
      'signaling',
      'signal_send',
      'protocol',
      'sink',
      'transfer',
      'integrity',
      'too_big',
      'unknown',
    ),
    ms: count,
    ice_state: oneOf('', 'new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'),
    gather_state: oneOf('', 'new', 'gathering', 'complete'),
    had_remote: bool,
    local_host: count,
    local_srflx: count,
    local_relay: count,
    remote_host: count,
    remote_srflx: count,
    remote_relay: count,
    turn_urls_supplied: count,
    turn_urls_configured: count,
    moved_bucket: sizeBucket,
    size_bucket: sizeBucket,
    restarts: count,
    // Whether the reporting tab was on screen when the run died — the lead a
    // slept machine or a frozen background tab leaves behind.
    visibility: oneOf('visible', 'hidden', 'prerender'),
  },
  'direct.fallback_started': { size_bucket: sizeBucket },
  'direct.fallback_ready': { size_bucket: sizeBucket, duration_ms: count, retries: count },
  'direct.fallback_received': { size_bucket: sizeBucket, duration_ms: count, retries: count },
  'direct.fallback_failed': {
    stage: oneOf('upload', 'download'),
    size_bucket: sizeBucket,
    retries: count,
  },
  'direct.fallback_aborted': {},
  'direct.too_big': { size_bucket: sizeBucket },
  'agent.pair_opened': { agent_kind: agentKind, protocol: count, replaces: bool },
  'agent.pair_approved': {
    agent_kind: agentKind,
    destination: oneOf('new_channel', 'existing'),
    channels: count,
    handoff: pairHandoff,
  },
  'agent.pair_refused': {
    agent_kind: agentKind,
    step: oneOf('open', 'approve', 'claim'),
    reason: oneOf(
      'agent_limit', 'grant_limit', 'channel_limit', 'code_mismatch',
      'pairing_expired', 'pairing_cancelled', 'pairing_claimed', 'feature_disabled',
      'rate_limited', 'network', 'other',
    ),
  },
  'agent.paired': {
    agent_kind: agentKind,
    destination: oneOf('new_channel', 'existing'),
    channels: count,
    handoff: pairHandoff,
    protocol: count,
  },
  'agent.revoked': { agent_kind: agentKind },
  'agent.send': { size_bucket: sizeBucket, agent_kind: agentKind },
  // What the CLI reports after every tool call: the tool, whether it worked,
  // the code when it did not, and the version that answered. No path, no file
  // name, no channel, no sentence.
  'agent.tool_call': {
    tool: oneOf(...AGENT_TOOL_NAMES),
    result: oneOf('ok', 'error'),
    code: oneOf(...AGENT_ERROR_CODES),
    agent_kind: agentKind,
    duration_bucket: oneOf('lt_1s', '1_10s', '10_60s', 'gt_60s'),
    version_major: count,
    version_minor: count,
    version_patch: count,
  },
};

const platformRule = oneOf('web', 'android', 'ios', 'agent', 'unknown');

function valid(rule: Rule, value: unknown): value is AnalyticsScalar {
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) && (rule.min === undefined || value >= rule.min);
  }
  return typeof value === 'string' && rule.values.has(value);
}

/** Keep only the documented properties for this event. `platform` is the one
 * common property and is itself a closed value. */
export function sanitizeProductEventProperties(
  event: ProductEvent,
  properties: unknown,
): AnalyticsProperties {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  const input = properties as Record<string, unknown>;
  const rules = EVENT_PROPERTY_RULES[event];
  const output: AnalyticsProperties = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = key === 'platform' ? platformRule : rules[key];
    if (rule && valid(rule, value)) output[key] = value;
  }
  return output;
}

const PERSON_PROPERTY_RULES: Readonly<Record<string, Rule>> = {
  plan: oneOf('anon', 'free', 'pro', 'max'),
  locale: oneOf('es-AR', 'pt-BR', 'en'),
  storage_bytes: count,
};

/** Person records have a smaller closed schema than events. */
export function sanitizeAnalyticsPersonProperties(properties: unknown): AnalyticsProperties {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  const output: AnalyticsProperties = {};
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    const rule = PERSON_PROPERTY_RULES[key];
    if (rule && valid(rule, value)) output[key] = value;
  }
  return output;
}

export function isProductEvent(value: string): value is ProductEvent {
  return (PRODUCT_EVENTS as readonly string[]).includes(value);
}
