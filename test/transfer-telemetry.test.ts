import { afterEach, expect, it, vi } from 'vitest';
import { TransferTelemetry, itemKind } from '../src/transfer-telemetry.js';
import type { ZasClient } from '../src/client.js';
vi.mock('../src/telemetry.js', () => ({ telemetryState: () => ({ on: process.env.DO_NOT_TRACK !== '1' }) }));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it('bounds stages and slow signals, correlates one finish, and strips content', () => {
  vi.useFakeTimers();
  const api = vi.fn().mockResolvedValue(undefined);
  const timer = new TransferTelemetry({api} as unknown as ZasClient, 'upload', 'code', 'manifest');
  timer.describe(12); timer.mark('encrypting'); timer.mark('encrypting');
  vi.advanceTimersByTime(90_000);
  timer.finish('success'); timer.finish('failure');
  vi.advanceTimersByTime(1);
  const events = api.mock.calls.flatMap(c => c[2].events);
  expect(api.mock.calls.length).toBeLessThanOrEqual(3);
  expect(events.filter(e => e.event === 'transfer.slow')).toHaveLength(1);
  expect(events.filter(e => e.event === 'transfer.stage_started')).toHaveLength(1);
  expect(events.filter(e => e.event === 'transfer.finished')).toHaveLength(1);
  expect(new Set(events.map(e => e.properties.transfer_id)).size).toBe(1);
  expect(events.at(-1).properties).toMatchObject({item_kind:'code',transport:'manifest',size_bytes:12,outcome:'success'});
  expect(JSON.stringify(events)).not.toMatch(/filename|channel_id|text|path|secret/);
});
it('honors opt-out and survives reporting failures', () => {
  vi.useFakeTimers();
  vi.stubEnv('DO_NOT_TRACK', '1');
  const api = vi.fn().mockRejectedValue(new Error('private path'));
  new TransferTelemetry({api} as unknown as ZasClient, 'download', 'file', 'storage').finish('success');
  vi.advanceTimersByTime(1);
  expect(api).not.toHaveBeenCalled();
  vi.stubEnv('DO_NOT_TRACK', '0');
  expect(() => new TransferTelemetry({api} as unknown as ZasClient, 'download', 'file', 'storage').failed(new Error('secret'))).not.toThrow();
  vi.advanceTimersByTime(1);
});
it('classifies notes, code and links without retaining content', () => {
  expect(itemKind({text:'hello'})).toBe('text');
  expect(itemKind({text:'https://example.com/secret'})).toBe('link');
  expect(itemKind({text:'anything',lang:'python'})).toBe('code');
});

it('does no settings IO or API work inline and never waits for a stalled report', async () => {
  vi.useFakeTimers();
  const api = vi.fn(() => new Promise(() => {}));
  const client = {api} as unknown as ZasClient;
  const timer = new TransferTelemetry(client, 'upload', 'text', 'manifest');
  timer.mark('encrypting'); timer.finish('success');
  expect(api).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api).toHaveBeenCalledOnce();
  // Pending report does not prevent the next item from finishing.
  new TransferTelemetry(client, 'upload', 'text', 'manifest').finish('success');
});
it('caps pending event snapshots instead of flushing overflow on the item path', () => {
  vi.useFakeTimers();
  const api = vi.fn().mockResolvedValue(undefined);
  const client = {api} as unknown as ZasClient;
  for (let i=0;i<1000;i++) new TransferTelemetry(client,'upload','text','manifest').finish('success');
  expect(api).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(api).toHaveBeenCalledOnce();
  expect(api.mock.calls[0][2].events.length).toBeLessThanOrEqual(32);
});
