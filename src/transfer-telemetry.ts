import { randomUUID } from 'node:crypto';
import { sanitizeProductEventProperties, type AgentTransferEvent } from './shared/product-analytics.js';
import type { ZasClient } from './client.js';
import { telemetryState } from './telemetry.js';

type Report = { event: AgentTransferEvent; properties: ReturnType<typeof sanitizeProductEventProperties> };
const pending = new WeakMap<ZasClient, { events: Report[]; timer: ReturnType<typeof setTimeout> }>();
function flush(client: ZasClient): void {
  const queue = pending.get(client);
  if (!queue) return;
  clearTimeout(queue.timer); pending.delete(client);
  try {
    if (!telemetryState().on) return;
    const body = { events: queue.events };
    void (client.reportTelemetry ? client.reportTelemetry(body) : client.api('POST', '/agents/telemetry', body)).catch(() => undefined);
  } catch { /* reporting is never part of an item's result */ }
}
function enqueue(client: ZasClient, report: Report): void {
  let queue = pending.get(client);
  if (!queue) {
    const timer = setTimeout(() => flush(client), 0);
    timer.unref?.(); queue = { events: [], timer }; pending.set(client, queue);
  }
  if (queue.events.length < 32) queue.events.push(report);
  // Never flush inline: settings reads, token refresh and signing belong to
  // the later task, even for the final event. Drop overflow instead of waiting.

}

export function itemKind(item: { kind?: string; code?: unknown; lang?: string; link_preview?: unknown; text?: string }): string {
  if (item.kind === 'file') return 'file';
  if (item.code || item.lang) return 'code';
  if (item.link_preview || /^https?:\/\/\S+$/.test(item.text?.trim() ?? '')) return 'link';
  return item.kind === 'text' || item.text !== undefined ? 'text' : 'unknown';
}
/** Bounded events; reports never delay or fail an item operation. */
export class TransferTelemetry {
  private readonly id = randomUUID();
  private readonly started = performance.now();
  private changed = this.started;
  private stage = 'staging';
  private readonly seen = new Set<string>();
  private readonly spans = new Map<string, number>();
  private ended = false;
  private readonly slow: ReturnType<typeof setTimeout>;
  private size = 0;
  private completed = 0;
  constructor(private readonly client: ZasClient, private readonly direction: 'upload' | 'download',
    private kind: string, private transport: string) {
    this.capture('transfer.started');
    this.slow = setTimeout(() => this.capture('transfer.slow'), 30_000);
    this.slow.unref?.();
  }
  describe(size: number, kind = this.kind, transport = this.transport): void {
    this.size = Math.max(0, size); this.kind = kind; this.transport = transport;
  }
  progress(bytes: number): void { this.completed = Math.max(this.completed, bytes); }
  mark(phase: string): void {
    if (this.ended) return;
    const stage = ({ hashing: 'staging', waiting: 'staging', connecting: 'authorization',
      flight: this.direction === 'upload' ? 'uploading' : 'downloading', done: 'finishing' } as Record<string, string>)[phase] ?? phase;
    if (!['staging','encrypting','uploading','finishing','authorization','downloading','decrypting','assembling'].includes(stage)) return;
    const now = performance.now();
    this.spans.set(this.stage, (this.spans.get(this.stage) ?? 0) + now - this.changed);
    this.changed = now; this.stage = stage;
    if (!this.seen.has(stage)) { this.seen.add(stage); this.capture('transfer.stage_started'); }
  }
  finish(outcome: string, error = 'none', cacheHit = false): void {
    if (this.ended) return;
    this.mark(this.stage); this.ended = true;
    if (outcome === 'success') this.completed = this.size; clearTimeout(this.slow);
    for (const [stage, duration] of this.spans) this.capture('transfer.phase_timing', {
      stage, duration_ms: Math.round(duration), timing_mode: 'wall', outcome,
    });
    this.capture('transfer.finished', { outcome, error_code: error, cache_hit: cacheHit });
  }
  failed(error: unknown): void {
    const e = error as { name?: string; code?: string; status?: number };
    const cancelled = e?.name === 'AbortError' || e?.code === 'cancelled';
    const code = cancelled ? 'none' : this.stage === 'decrypting' ? 'crypto' : e?.status === 401 || e?.status === 403 ? 'authorization' :
      e?.code === 'timeout' ? 'timeout' : e?.code === 'network' || error instanceof TypeError ? 'network' :
      e?.code === 'write_failed' ? 'storage' : this.stage === 'decrypting' ? 'crypto' : 'other';
    this.finish(cancelled ? 'cancelled' : 'failure', code);
  }
  private capture(event: AgentTransferEvent, extra: Record<string, string | number | boolean> = {}): void {
    try {
      const mb = this.size / 1048576;
      const properties = sanitizeProductEventProperties(event, {
        transfer_id: this.id, telemetry_version: 1, direction: this.direction,
        purpose: this.direction === 'upload' ? 'send' : 'download', item_kind: this.kind,
        transport: this.transport, size_bytes: this.size, bytes_completed: this.completed,
        size_bucket: mb < 1 ? 'lt_1mb' : mb < 10 ? '1_10mb' : mb < 100 ? '10_100mb' : mb < 512 ? '100_512mb' : mb < 5120 ? '512mb_5gb' : 'gt_5gb',
        stage: this.stage, duration_ms: Math.round(performance.now() - this.started), ...extra,
      });
      enqueue(this.client, { event, properties });
    } catch { /* opt-out storage, offline or unavailable analytics must not affect work */ }
  }
}
