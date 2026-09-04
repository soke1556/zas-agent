// What this agent reports about itself, and the switch that stops it.
//
// The report goes to Zas, never to an analytics service: this package holds no
// project token, opens no connection to a third party, and sends no identifier
// of its own. The account a report counts against is the one on the session,
// decided by the server. What travels is a tool name, whether the call worked,
// the error code when it did not, a duration bucket and the version — no path,
// no file name, no channel name, and never the sentence a person reads.
import {
  AGENT_TOOL_NAMES,
  agentDurationBucket,
  type AnalyticsProperties,
} from './shared/product-analytics.js';
import type { ZasClient } from './client.js';
import { loadSettings, saveSettings } from './identity.js';

/** Which of the four answers decided. The `telemetry` command prints it, so a
 *  person who turned it off in a shell profile can see why the file says
 *  otherwise. */
export type TelemetrySource = 'env' | 'do_not_track' | 'file' | 'default';

const OFF_WORDS = new Set(['0', 'off', 'false', 'no']);
const ON_WORDS = new Set(['1', 'on', 'true', 'yes']);

/** Read at call time, never at import: an MCP client sets the environment for
 *  the process it starts, and a test sets it after this module is loaded. */
export function telemetryState(): { on: boolean; source: TelemetrySource } {
  const env = (process.env.ZAS_AGENT_TELEMETRY ?? '').toLowerCase();
  if (OFF_WORDS.has(env)) return { on: false, source: 'env' };
  if (ON_WORDS.has(env)) return { on: true, source: 'env' };
  // The cross-vendor switch. It only turns telemetry off; nobody sets
  // DO_NOT_TRACK=0 to ask for more of it.
  if (process.env.DO_NOT_TRACK === '1') return { on: false, source: 'do_not_track' };
  const stored = loadSettings();
  if (stored && typeof stored.telemetry === 'boolean') return { on: stored.telemetry, source: 'file' };
  return { on: true, source: 'default' };
}

export function setTelemetry(on: boolean): void {
  const stored = loadSettings();
  saveSettings({ ...(stored ?? {}), version: 1, telemetry: on, decided_at: Date.now() });
}

/** Whether the notice has been printed on this machine. `pair` prints it every
 *  time — a person is at the terminal — and `serve` only once. */
export function noticeShown(): boolean {
  return typeof loadSettings()?.notified_at === 'number';
}

export function markNoticeShown(): void {
  const stored = loadSettings();
  saveSettings({ ...(stored ?? {}), version: 1, notified_at: Date.now() });
}

export const TELEMETRY_NOTICE = [
  'Zas collects usage data from this agent to improve the product: which tool',
  'ran, whether it worked, the error code when it did not, how long it took,',
  'and the version. Never file names, file contents, paths or channel names.',
  'The data is linked to your Zas account.',
  'Turn it off with: npx -y zas-agent telemetry off',
].join('\n');

const SOURCE_WORDS: Record<TelemetrySource, string> = {
  env: 'ZAS_AGENT_TELEMETRY',
  do_not_track: 'DO_NOT_TRACK',
  file: 'zas-agent telemetry',
  default: 'default',
};

/** The line `zas-agent telemetry` and `zas_status` both print. */
export function telemetryLine(): string {
  const state = telemetryState();
  return `telemetry: ${state.on ? 'on' : 'off'} (${SOURCE_WORDS[state.source]})`;
}

const TOOL_NAMES = new Set<string>(AGENT_TOOL_NAMES);

/** The three numbers of a version. A version string is not a closed value and
 *  a rule that accepted one would accept anything, so it travels as numbers.
 *  An unreadable version is zeroes, which is what `0.0.0-dev` already is. */
export function versionParts(version: string): { major: number; minor: number; patch: number } {
  const [major = 0, minor = 0, patch = 0] = version
    .split('-')[0]
    .split('.')
    .map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    });
  return { major, minor, patch };
}

/** The properties of one `agent.tool_call`, or null when the tool is not one
 *  this vocabulary names — a tool added to the server and not to the shared
 *  list, which `server.test.ts` fails on. `code` is null for a call that
 *  worked. */
export function toolCallProperties(input: {
  tool: string;
  ms: number;
  code: string | null;
  version: string;
}): AnalyticsProperties | null {
  const tool = input.tool.startsWith('zas_') ? input.tool.slice(4) : input.tool;
  if (!TOOL_NAMES.has(tool)) return null;
  const version = versionParts(input.version);
  return {
    tool,
    result: input.code === null ? 'ok' : 'error',
    // `other` is the server's word for a code outside the vocabulary. The
    // shared list is the one that decides, and it drops anything else.
    code: input.code ?? 'none',
    duration_bucket: agentDurationBucket(input.ms),
    version_major: version.major,
    version_minor: version.minor,
    version_patch: version.patch,
  };
}

/** How long the report is worth waiting for. It is already fire-and-forget;
 *  this only stops a stalled connection from holding a promise for minutes. */
const REPORT_TIMEOUT_MS = 5_000;

/** One report. It never rejects, never retries, and never delays what the tool
 *  answered: a tool call's result must not depend on whether analytics worked.
 *  Off means no request at all. */
export async function report(client: ZasClient, properties: AnalyticsProperties | null): Promise<void> {
  if (properties === null || !telemetryState().on) return;
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, REPORT_TIMEOUT_MS);
    // Nothing here is a reason to keep the process alive.
    timer.unref?.();
  });
  const sent = client
    .api('POST', '/agents/telemetry', { event: 'agent.tool_call', properties })
    .then(() => undefined)
    .catch(() => undefined);
  await Promise.race([sent, timeout]);
}
