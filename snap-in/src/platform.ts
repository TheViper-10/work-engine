// Shared platform plumbing: the three API interfaces the adapters use, the real HTTP implementations,
// retry helper and small utilities. Adapters depend only on the interfaces, so the offline fake and the
// live HTTP client are interchangeable. Nothing here holds a secret value: tokens are read from the
// invocation event at call time.
import { createHash } from 'node:crypto';
import type { Clock } from '../../src/types.ts';

export type Identity = 'caller' | 'service' | 'owner';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly type?: string, readonly debug?: string) {
    super(message);
    this.name = 'ApiError';
  }
  /** No answer at all (timeout, network): the request may or may not have been applied. */
  get ambiguous(): boolean { return this.status === 0 || this.status >= 500; }
}

export interface DevRevApi {
  call(path: string, body: Record<string, unknown>, as?: Identity): Promise<any>;
}
export interface SlackApi {
  get(method: string, params: Record<string, string | number>): Promise<any>;
}
export interface GithubApi {
  /** GET only. `path` starts with /repos/. */
  get(path: string): Promise<any>;
}

export interface Deps {
  devrev(event: any): DevRevApi;
  slack(event: any): SlackApi;
  github(event: any): GithubApi;
  clock: Clock;
  sleep?(ms: number): Promise<void>;
}

/** Bind a fixed identity so adapters never choose a token themselves. */
export function scoped(api: DevRevApi, as: Identity): DevRevApi {
  return { call: (path, body) => api.call(path, body, as) };
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry an idempotent request on 429, timeout and 5xx. */
export async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = realSleep, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!(e instanceof ApiError) || !(e.status === 429 || e.ambiguous) || i === tries - 1) throw e;
      await sleep(200 * 2 ** i);
    }
  }
  throw last;
}

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

// ---------------------------------------------------------------- real HTTP (never used offline)

export const QA_ENDPOINT = 'https://api.qa.devrev-eng.ai';

function fail(message: string): never { throw new Error(message); }
function bare(v: unknown): string { return String(v).replace(/^Bearer\s+/i, ''); }

export function keyring(event: any, name: string): string {
  const value = event?.input_data?.resources?.keyrings?.[name]?.secret ?? event?.input_data?.keyrings?.[name];
  if (!value) fail(`${name} keyring is unavailable`);
  return bare(value);
}

function tokenFor(event: any, as: Identity): string {
  if (as === 'owner') return keyring(event, 'owner_identity');
  const value = event?.context?.secrets?.[as === 'caller' ? 'access_token' : 'service_account_token'];
  if (!value) fail(`${as} token is unavailable`);
  return bare(value);
}

async function send(url: string, init: RequestInit, label: string): Promise<any> {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) }); } catch { throw new ApiError(0, `${label} unavailable`, 'timeout'); }
  const parsed: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, `${label} failed (${res.status}, ${parsed.type || 'request_failed'})`, parsed.type, parsed.debug_message);
  return parsed;
}

export const httpDeps: Deps = {
  clock: { now: () => Date.now() },
  devrev(event) {
    if (event?.execution_metadata?.devrev_endpoint !== QA_ENDPOINT) fail('QA endpoint required');
    return {
      call: (path, body, as = 'caller') => send(`${QA_ENDPOINT}/internal/${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${tokenFor(event, as)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, path),
    };
  },
  slack(event) {
    return {
      async get(method, params) {
        const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
        const out = await send(`https://slack.com/api/${method}?${qs}`, { headers: { Authorization: `Bearer ${keyring(event, 'tony_slack_token')}` } }, `slack ${method}`);
        if (out.ok === false) throw new ApiError(out.error === 'ratelimited' ? 429 : 200, `slack ${method} failed (${out.error})`, out.error);
        return out;
      },
    };
  },
  github(event) {
    return {
      get: (path) => send(`https://api.github.com${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${keyring(event, 'github_read')}`, Accept: 'application/vnd.github+json', 'User-Agent': 'work-engine-qa' },
      }, 'github'),
    };
  },
};
