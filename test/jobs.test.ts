import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZasError } from '../src/errors.js';
import { JobRunner } from '../src/jobs.js';
import type { SendResult } from '../src/send.js';

const result: SendResult = {
  link_id: 'L1', channel_id: 'c1', channel_name: 'Trabajo',
  bytes: 10, chunks: 1, deduplicated: 0, replayed: false,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('JobRunner', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves as soon as the work finishes, with the phases it reported', async () => {
    const runner = new JobRunner();
    const job = runner.start('file', 'notas.txt', 'Trabajo', async (report) => {
      report('hashing');
      await sleep(100);
      report('finishing');
      return result;
    });
    expect(job.status).toBe('running');
    const waiting = runner.wait(job);
    await vi.advanceTimersByTimeAsync(100);
    const done = await waiting;
    expect(done.status).toBe('done');
    expect(done.phase).toBe('finishing');
    expect(done.result).toEqual(result);
    expect(runner.get(job.id)).toBe(done);
  });

  it('gives up waiting after waitMs and hands back a job still running', async () => {
    const runner = new JobRunner();
    const job = runner.start('file', 'grande.bin', 'Trabajo', async (report) => {
      report('uploading');
      await sleep(120_000);
      return result;
    });
    const waiting = runner.wait(job);
    await vi.advanceTimersByTimeAsync(60_000);
    const pending = await waiting;
    expect(pending.status).toBe('running');
    expect(pending.phase).toBe('uploading');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.get(job.id)!.status).toBe('done');
  });

  it('marks a failure with the code and a sentence for the terminal', async () => {
    const runner = new JobRunner();
    const job = runner.start('note', 'nota', 'Trabajo', async () => {
      throw new ZasError('quota_exceeded', 403);
    });
    const failed = await runner.wait(job);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('quota_exceeded');
    expect(failed.error?.sentence.length).toBeGreaterThan(0);
    expect(failed.result).toBeUndefined();
  });

  it('names an ordinary throw rather than losing it', async () => {
    const runner = new JobRunner();
    const job = runner.start('file', 'x', 'Trabajo', async () => { throw new Error('boom'); });
    const failed = await runner.wait(job);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('upload_failed');
  });

  it('keeps the last fifty jobs, newest first', async () => {
    const runner = new JobRunner({ waitMs: 1000 });
    const jobs = [];
    for (let i = 0; i < 60; i++) jobs.push(runner.start('file', `f${i}`, 'Trabajo', async () => result));
    await vi.advanceTimersByTimeAsync(0);
    const list = runner.list();
    expect(list).toHaveLength(50);
    expect(list[0].title).toBe('f59');
    expect(list[49].title).toBe('f10');
    expect(runner.get(jobs[0].id)).toBeUndefined();
    // A caller that already holds a trimmed job can still wait on it.
    expect((await runner.wait(jobs[0])).status).toBe('done');
  });

  it('stamps started_at from the clock it was given', () => {
    const runner = new JobRunner({ now: () => 12_345 });
    expect(runner.start('direct', 'x', 'Trabajo', async () => result).started_at).toBe(12_345);
  });
});
