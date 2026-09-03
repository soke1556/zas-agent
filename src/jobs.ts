// A send can outlive the call that asked for it. An MCP tool answers in
// seconds or the caller gives up, and a five-gigabyte upload does not fit in
// seconds — so the work is started, waited on for a while, and then reported
// as still running with an id the caller can ask about later.
import { randomUUID } from 'node:crypto';
import type { DirectJobPhase, DirectResult } from './direct.js';
import { humanSentence, ZasError } from './errors.js';
import type { SendPhase, SendResult } from './send.js';

export type JobPhase = SendPhase | DirectJobPhase;
export type JobResult = SendResult | DirectResult;

/** Enough of the `ZasError` to build it again. A job's failure has to answer
 *  exactly as the same failure thrown from the call would — with the path in
 *  `identity_corrupt`'s sentence, and with the retry hint the server sent —
 *  and the code alone cannot carry either. `message` is only ever kept for a
 *  `ZasError`, whose message is a path or a server word; a raw `String(e)`
 *  could hold a signed URL and never reaches this record. */
export interface JobError {
  code: string;
  status: number;
  sentence: string;
  message?: string;
  retryAfterMs?: number;
  serverCode?: string;
}

export interface Job {
  id: string;
  kind: 'file' | 'note' | 'direct' | 'fallback';
  title: string;
  channel: string;
  started_at: number;
  phase: JobPhase | null;
  status: 'running' | 'done' | 'failed';
  result?: JobResult;
  error?: JobError;
}

/** How long a caller waits before the answer becomes "still going". Long
 *  enough that an ordinary send finishes inside it. */
const DEFAULT_WAIT_MS = 60_000;

/** Enough history for "what did you just send?" and nothing like a log. A
 *  process that runs for a week must not grow a job per send — but a `job_id`
 *  a send handed back has to still be here when the caller comes to redeem it,
 *  and twenty sends is a short session. */
const HISTORY = 50;

export class JobRunner {
  private readonly now: () => number;
  private readonly waitMs: number;
  /** Newest first, and trimmed. */
  private readonly jobs: Job[] = [];
  /** Keyed on the job object, not its id, so a caller holding a job that has
   *  already aged out of the list can still wait for it to finish. */
  private readonly settled = new WeakMap<Job, Promise<Job>>();

  constructor(opts: { now?: () => number; waitMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  }

  start(
    kind: Job['kind'],
    title: string,
    channel: string,
    work: (report: (phase: JobPhase) => void) => Promise<JobResult>,
  ): Job {
    const job: Job = {
      id: randomUUID(),
      kind,
      title,
      channel,
      started_at: this.now(),
      phase: null,
      status: 'running',
    };
    this.jobs.unshift(job);
    this.jobs.length = Math.min(this.jobs.length, HISTORY);
    const report = (phase: JobPhase): void => {
      if (job.status === 'running') job.phase = phase;
    };
    // The promise is settled here and never rethrown: a failure is a field on
    // the job, and an unobserved rejection would take the process down.
    this.settled.set(job, work(report).then(
      (result) => {
        job.status = 'done';
        job.result = result;
        return job;
      },
      (error: unknown) => {
        job.status = 'failed';
        job.error = error instanceof ZasError
          ? {
            code: error.code,
            status: error.status,
            sentence: humanSentence(error),
            message: error.message,
            ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
            ...(error.serverCode !== undefined ? { serverCode: error.serverCode } : {}),
          }
          // Not a code of its own: `send_failed` was outside the closed set,
          // and a word only this file knew is a word no caller could handle.
          : { code: 'upload_failed', status: 0, sentence: humanSentence(new ZasError('upload_failed', 0)) };
        return job;
      },
    ));
    return job;
  }

  /** Resolves when the work settles, or when the wait runs out — the same job
   *  object either way, so the caller reads `status` rather than guessing. */
  async wait(job: Job): Promise<Job> {
    const settled = this.settled.get(job);
    if (!settled) return job;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Job>((resolve) => {
      timer = setTimeout(() => resolve(job), this.waitMs);
    });
    try {
      return await Promise.race([settled, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  list(): Job[] {
    return this.jobs.slice(0, HISTORY);
  }

  get(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id);
  }
}
