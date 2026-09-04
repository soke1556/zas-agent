// The switch, and what one report is allowed to be. Everything here is
// offline: the point of the module is that it decides whether to speak at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ZasClient } from '../src/client.js';
import { loadSettings, saveSettings } from '../src/identity.js';
import {
  report,
  setTelemetry,
  telemetryLine,
  telemetryState,
  toolCallProperties,
  versionParts,
} from '../src/telemetry.js';

const recorder = (api: (method: string, path: string, body?: unknown) => Promise<unknown>) => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return api(method, path, body);
    }),
  } as unknown as ZasClient;
  return { client, calls };
};

describe('the telemetry switch', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-agent-telemetry-'));
    process.env.ZAS_AGENT_HOME = home;
    delete process.env.ZAS_AGENT_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    delete process.env.ZAS_AGENT_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    rmSync(home, { recursive: true, force: true });
  });

  it('is on when nobody has chosen', () => {
    expect(telemetryState()).toEqual({ on: true, source: 'default' });
    expect(telemetryLine()).toBe('telemetry: on (default)');
  });

  it('takes the environment first, in either direction', () => {
    process.env.ZAS_AGENT_TELEMETRY = 'off';
    setTelemetry(true);
    expect(telemetryState()).toEqual({ on: false, source: 'env' });
    process.env.ZAS_AGENT_TELEMETRY = '1';
    setTelemetry(false);
    expect(telemetryState()).toEqual({ on: true, source: 'env' });
  });

  it('honours DO_NOT_TRACK, which only ever turns it off', () => {
    process.env.DO_NOT_TRACK = '1';
    expect(telemetryState()).toEqual({ on: false, source: 'do_not_track' });
    // Nobody asks for more telemetry by setting it to zero, and the file below
    // it still decides.
    process.env.DO_NOT_TRACK = '0';
    expect(telemetryState()).toEqual({ on: true, source: 'default' });
  });

  it('remembers the choice next to the profiles, not inside one', () => {
    setTelemetry(false);
    expect(telemetryState()).toEqual({ on: false, source: 'file' });
    expect(loadSettings()).toMatchObject({ version: 1, telemetry: false });
    expect(typeof loadSettings()?.decided_at).toBe('number');
    // The file lives in the agent home, so a profile paired again keeps it.
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toMatchObject({ telemetry: false });
    setTelemetry(true);
    expect(telemetryState()).toEqual({ on: true, source: 'file' });
  });

  it('keeps the notice mark when the choice changes', () => {
    saveSettings({ version: 1, notified_at: 5 });
    setTelemetry(false);
    expect(loadSettings()).toMatchObject({ notified_at: 5, telemetry: false });
  });

  it('reads a damaged settings file as no choice at all', () => {
    writeFileSync(join(home, 'settings.json'), '{ not json');
    expect(telemetryState()).toEqual({ on: true, source: 'default' });
  });
});

describe('one report', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zas-agent-report-'));
    process.env.ZAS_AGENT_HOME = home;
    delete process.env.ZAS_AGENT_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(() => {
    delete process.env.ZAS_AGENT_HOME;
    delete process.env.ZAS_AGENT_TELEMETRY;
    rmSync(home, { recursive: true, force: true });
  });

  it('posts the event and its properties, and nothing else', async () => {
    const { client, calls } = recorder(async () => undefined);
    await report(client, toolCallProperties({ tool: 'zas_send_file', ms: 2_500, code: null, version: '0.6.0' }));
    expect(calls).toEqual([{
      method: 'POST',
      path: '/agents/telemetry',
      body: {
        event: 'agent.tool_call',
        properties: {
          tool: 'send_file',
          result: 'ok',
          code: 'none',
          duration_bucket: '1_10s',
          version_major: 0, version_minor: 6, version_patch: 0,
        },
      },
    }]);
  });

  it('sends nothing at all when it is off', async () => {
    setTelemetry(false);
    const { client, calls } = recorder(async () => undefined);
    await report(client, toolCallProperties({ tool: 'zas_status', ms: 1, code: null, version: '0.6.0' }));
    expect(calls).toEqual([]);
  });

  it('sends nothing for a tool the vocabulary does not name', async () => {
    const { client, calls } = recorder(async () => undefined);
    expect(toolCallProperties({ tool: 'zas_delete_everything', ms: 1, code: null, version: '0.6.0' })).toBeNull();
    await report(client, null);
    expect(calls).toEqual([]);
  });

  it('carries the code of a call that failed', () => {
    expect(toolCallProperties({ tool: 'zas_receive_direct', ms: 65_000, code: 'no_offer', version: '1.2.3' }))
      .toEqual({
        tool: 'receive_direct',
        result: 'error',
        code: 'no_offer',
        duration_bucket: 'gt_60s',
        version_major: 1, version_minor: 2, version_patch: 3,
      });
  });

  it('never lets a refused report reach the caller', async () => {
    const { client } = recorder(async () => { throw new Error('502 from a proxy'); });
    await expect(report(client, toolCallProperties({ tool: 'zas_jobs', ms: 1, code: null, version: '0.6.0' })))
      .resolves.toBeUndefined();
  });

  it('stops waiting on a report that never answers', async () => {
    vi.useFakeTimers();
    try {
      const { client } = recorder(() => new Promise<unknown>(() => undefined));
      const pending = report(client, toolCallProperties({ tool: 'zas_jobs', ms: 1, code: null, version: '0.6.0' }));
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a version, and zeroes anything it cannot', () => {
    expect(versionParts('0.6.0')).toEqual({ major: 0, minor: 6, patch: 0 });
    expect(versionParts('0.0.0-dev')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(versionParts('what')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(versionParts('2')).toEqual({ major: 2, minor: 0, patch: 0 });
  });
});
