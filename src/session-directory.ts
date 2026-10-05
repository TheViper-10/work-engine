// Session directory implementations (A1). The interface lives in types.ts.
import type { SessionDirectory, SessionLookup, ThreadLookup } from './types.ts';

export type { SessionDirectory, SessionLookup } from './types.ts';

/**
 * Harness transition only: every session is treated as living in the job's home, so the
 * pre-ownership harness keeps working until it supplies a real directory. Not a production default.
 */
export const homeForAllSessions: SessionDirectory = {
  cacheable: false,
  async dmOf(_sessionId, job): Promise<SessionLookup> {
    return job ? { dm: job.dm } : { error: 'no job given to the offline default directory' };
  },
};

/** Offline fake with failure injection: a map of session to DM. */
export class FakeSessionDirectory implements SessionDirectory {
  private readonly dms = new Map<string, string>();
  private readonly failing = new Set<string>();
  failAll = false;
  lookups = 0;

  /** Custom fields of connector DMs, as the Slack connector writes them (channel, thread ts, prompt ts), keyed by DM. */
  private readonly fields = new Map<string, Record<string, string>>();
  set(sessionId: string, dm: string): void { this.dms.set(sessionId, dm); }
  /** A connector DM: the session lives in `dm`, which carries the Slack channel and thread as custom fields (R51). */
  setConnectorDm(sessionId: string, dm: string, f: { channel: string; threadTs: string; promptTs?: string }): void {
    this.dms.set(sessionId, dm);
    this.fields.set(dm, { slack_channel: f.channel, slack_thread_ts: f.threadTs, prompt_ts: f.promptTs ?? f.threadTs });
  }
  async threadOf(sessionId: string): Promise<ThreadLookup> {
    if (this.failAll || this.failing.has(sessionId)) return { error: 'session lookup failed' };
    const f = this.fields.get(this.dms.get(sessionId) ?? '');
    return f ? { thread: `${f.slack_channel}:${f.slack_thread_ts}`, prompt_ts: f.prompt_ts } : { error: 'this conversation carries no Slack channel and thread' };
  }
  /** Make lookups for one session (or every session with '*') fail until cleared. */
  fail(sessionId: string, on = true): void {
    if (sessionId === '*') this.failAll = on;
    else if (on) this.failing.add(sessionId); else this.failing.delete(sessionId);
  }
  async dmOf(sessionId: string): Promise<SessionLookup> {
    this.lookups += 1;
    if (this.failAll || this.failing.has(sessionId)) return { error: 'session lookup failed' };
    const dm = this.dms.get(sessionId);
    return dm ? { dm } : { error: 'unknown session' };
  }
}
