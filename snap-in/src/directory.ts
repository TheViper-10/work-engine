// PlatformSessionDirectory (A1): which DM a session lives in, looked up from the platform, never passed by the caller.
// The engine names homes `dm:<job>[:g<n>]`; the platform knows real DM ids. Two create-only rows map between them:
//   dmmap:<logical>       -> { state, dm, agent_version, created_at }   (written by the waker)
//   dmrev:<sha(real DM)>  -> { logical }
// dmOf returns the logical id when the session's DM is a job home, else the real DM id (a mention DM: non-home).
import { makeKey, type Store } from '../../src/store.ts';
import type { SessionDirectory, SessionLookup } from '../../src/types.ts';
import { ApiError, sha, type DevRevApi } from './platform.ts';

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
}
