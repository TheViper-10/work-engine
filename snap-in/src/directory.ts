// PlatformSessionDirectory (A1): which DM a session lives in, looked up from the platform, never passed by the caller.
// The engine names homes `dm:<job>[:g<n>]`; the platform knows real DM ids. Two create-only rows map between them:
//   dmmap:<logical>       -> { state, dm, agent_version, created_at }   (written by the waker)
//   dmrev:<sha(real DM)>  -> { logical }
// dmOf returns the logical id when the session's DM is a job home, else the real DM id (a mention DM: non-home).
import { makeKey, type Store } from '../../src/store.ts';
import type { SessionDirectory, SessionLookup, ThreadLookup } from '../../src/types.ts';
import { ApiError, sha, type DevRevApi } from './platform.ts';

/** Custom fields the Slack connector writes on the DM it opens for a mention (slack-agent-connector src/agent/constants.ts, buildDmFields). */
export const CF_SLACK_CHANNEL = 'app_slack_agent_connector__slack_channel';
export const CF_SLACK_THREAD_TS = 'app_slack_agent_connector__slack_thread_ts';
export const CF_PROMPT_TS = 'app_slack_agent_connector__prompt_ts';

export interface DmMapRow { state: 'creating' | 'created' | 'ready'; dm: string | null; agent_version: string | null; created_at: number }
export interface DmRevRow { logical: string }

export const dmmapKey = (env: string, bot: string, logical: string): string => makeKey(env, bot, 'dmmap', logical);
export const dmrevKey = (env: string, bot: string, realDm: string): string => makeKey(env, bot, 'dmrev', sha(realDm));

export class PlatformSessionDirectory implements SessionDirectory {
  /** The answer depends only on the session, so the engine may cache successes per session. */
  readonly cacheable = true;
  lookups = 0;

  constructor(private readonly o: { api: DevRevApi; store: Store; env: string; bot: string }) {}

  async dmOf(sessionId: string): Promise<SessionLookup> {
    this.lookups += 1;
    if (typeof sessionId !== 'string' || !sessionId) return { error: 'no session id' };
    let res: any;
    try { res = await this.o.api.call('ai-agent.sessions.get', { id: sessionId }); } catch (e) {
      // Failures are returned, never cached (the engine does not cache errors) and never guessed around.
      const why = e instanceof ApiError ? `${e.status} ${e.type ?? ''}`.trim() : (e as Error).message;
      return { error: `session lookup failed (${why})` };
    }
    const session = res?.agent_session;
    const parent = typeof session?.parent === 'string' && session.parent ? session.parent : null;
    if (!parent) return { error: 'session has no parent conversation' };
    let rev: DmRevRow | null;
    try { rev = await this.o.store.get<DmRevRow>(dmrevKey(this.o.env, this.o.bot, parent)); } catch (e) {
      return { error: `home lookup failed (${(e as Error).message})` };
    }
    return { dm: rev?.logical ?? parent };
  }

  /**
   * R51: the Slack thread a connector DM was opened for: session -> parent DM (sessions.get) -> the DM's custom fields (chats.get).
   * A failure (403, no fields, a DM that is not a connector DM) is an error result, never a guess.
   */
  async threadOf(sessionId: string): Promise<ThreadLookup> {
    if (typeof sessionId !== 'string' || !sessionId) return { error: 'no session id' };
    let parent: string | null;
    try {
      const res = await this.o.api.call('ai-agent.sessions.get', { id: sessionId });
      parent = typeof res?.agent_session?.parent === 'string' && res.agent_session.parent ? res.agent_session.parent : null;
    } catch (e) { return { error: `session lookup failed (${why(e)})` }; }
    if (!parent) return { error: 'session has no parent conversation' };
    let chat: any;
    try { chat = (await this.o.api.call('chats.get', { id: parent }))?.chat; } catch (e) { return { error: `conversation lookup failed (${why(e)})` }; }
    const f = chat?.custom_fields ?? {};
    const channel = typeof f[CF_SLACK_CHANNEL] === 'string' ? f[CF_SLACK_CHANNEL] : '';
    const ts = typeof f[CF_SLACK_THREAD_TS] === 'string' && f[CF_SLACK_THREAD_TS] ? f[CF_SLACK_THREAD_TS] : typeof f[CF_PROMPT_TS] === 'string' ? f[CF_PROMPT_TS] : '';
    if (!channel || !ts) return { error: 'this conversation carries no Slack channel and thread' };
    const prompt = typeof f[CF_PROMPT_TS] === 'string' && f[CF_PROMPT_TS] ? f[CF_PROMPT_TS] : undefined;
    return prompt ? { thread: `${channel}:${ts}`, prompt_ts: prompt } : { thread: `${channel}:${ts}` };
  }
}

function why(e: unknown): string { return e instanceof ApiError ? `${e.status} ${e.type ?? ''}`.trim() : (e as Error).message; }
