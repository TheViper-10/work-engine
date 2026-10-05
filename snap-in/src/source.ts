// GitHub SourceReader. GET only, one repo, one ref. The token (keyring github_read) is broader than the mock branch,
// so the restriction lives here. Any error returns null, which the engine treats as source_unreadable.
import type { SourceReader } from '../../src/types.ts';
import { makeKey, type Store } from '../../src/store.ts';
import type { GithubApi } from './platform.ts';

export interface SourceOptions {
  api: GithubApi;
  repo: string;
  branch: string;
  statePath: string;
  /** Gates whose build is the open PR head instead of the branch head. */
  prGates?: readonly string[];
}

export class GithubSourceError extends Error {}

export class GithubSourceReader implements SourceReader {
  constructor(private readonly o: SourceOptions) {}

  private guard(path: string): string {
    const repoPrefix = `/repos/${this.o.repo}/`;
    const decoded = decodeURIComponent(path);
    if (!path.startsWith(repoPrefix) || decoded.includes('..')) throw new GithubSourceError(`path outside ${this.o.repo}`);
    const [route, query = ''] = decoded.slice(repoPrefix.length).split('?');
    const q = new URLSearchParams(query);
    if (route === 'commits') { if (q.get('sha') !== this.o.branch) throw new GithubSourceError('ref not allowed'); }
    else if (route.startsWith('commits/')) { if (route !== `commits/${this.o.branch}`) throw new GithubSourceError('ref not allowed'); }
    else if (route === 'pulls') { if (q.get('base') !== this.o.branch) throw new GithubSourceError('base not allowed'); }
    else if (route.startsWith('contents/')) { if (route !== `contents/${this.o.statePath}` || q.get('ref') !== this.o.branch) throw new GithubSourceError('contents not allowed'); }
    else throw new GithubSourceError('route not allowed');
    return path;
  }

  private async get(path: string): Promise<any> { return this.o.api.get(this.guard(path)); }

  async currentBuild(_job: { id: string; workflow: string; target: string }, gate: string): Promise<string | null> {
    try {
      if (this.o.prGates?.includes(gate)) {
        const prs = await this.get(`/repos/${this.o.repo}/pulls?base=${encodeURIComponent(this.o.branch)}&state=open`);
        const sha = Array.isArray(prs) ? prs[0]?.head?.sha : null;
        return typeof sha === 'string' ? sha.slice(0, 8) : null;
      }
      // R57: the branch head is often the engine-less state commit a publish writes ("[skip ci]"), which no pipeline builds. The build a
      // gate is about is the newest commit that is not one of those (live run 1: head 1bbe07cf, pipeline build f32f69b2).
      const list = await this.get(`/repos/${this.o.repo}/commits?sha=${encodeURIComponent(this.o.branch)}&per_page=10`);
      const c = Array.isArray(list) ? list.find((x: any) => typeof x?.sha === 'string' && !/\[skip ci\]/i.test(String(x?.commit?.message ?? ''))) : null;
      return typeof c?.sha === 'string' ? c.sha.slice(0, 8) : null;
    } catch { return null; }
  }

  /** Served state from the state file on the branch (qa/latest, prod/alpha). Null on any error. */
  async servedState(): Promise<Record<string, unknown> | null> {
    try {
      const f = await this.get(`/repos/${this.o.repo}/contents/${this.o.statePath}?ref=${encodeURIComponent(this.o.branch)}`);
      if (typeof f?.content !== 'string') return null;
      return JSON.parse(Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'));
    } catch { return null; }
  }
}

/**
 * R57: `say` and `intend` run on the operation path, which carries no `github_read` keyring, so a live read there always failed and the
 * ask was keyed `unknown` (live run 1 F7). The timer path has the keyring: it refreshes a small snapshot per gate (only while a job is
 * open, written only when the build changed); the operation path falls back to that snapshot when it is fresh. A live read, when the
 * keyring is there, always wins and refreshes the snapshot. A stale or missing snapshot is still null (source_unreadable).
 */
export const SNAPSHOT_MAX_AGE_MS = 15 * 60_000;
/** An unchanged snapshot is rewritten at most this often (one row per 10 minutes while a job is open). */
export const SNAPSHOT_REWRITE_MS = 10 * 60_000;
export interface BuildSnapshot { builds: Record<string, string>; at: number }

export class SnapshotSourceReader implements SourceReader {
  constructor(private readonly o: { live: GithubSourceReader; store: Store; env: string; bot: string; now: () => number }) {}
  private key(): string { return makeKey(this.o.env, this.o.bot, 'source', 'builds'); }
  private async read(): Promise<BuildSnapshot | null> { return this.o.store.get<BuildSnapshot>(this.key()).catch(() => null); }

  async currentBuild(job: { id: string; workflow: string; target: string }, gate: string): Promise<string | null> {
    const live = await this.o.live.currentBuild(job, gate);
    if (live !== null) return live;
    const snap = await this.read();
    return snap && this.o.now() - snap.at <= SNAPSHOT_MAX_AGE_MS ? snap.builds[gate] ?? null : null;
  }

  /** Timer path (has the GitHub credential): read each gate's build and keep the one snapshot row current. */
  async refresh(gates: readonly string[]): Promise<void> {
    const builds: Record<string, string> = {};
    for (const gate of gates) { const b = await this.o.live.currentBuild({ id: '', workflow: '', target: '' }, gate); if (b !== null) builds[gate] = b; }
    if (!Object.keys(builds).length) return;
    const cur = await this.read();
    const same = !!cur && JSON.stringify(cur.builds) === JSON.stringify(builds);
    if (same && this.o.now() - cur!.at < SNAPSHOT_REWRITE_MS) return;
    await this.o.store.put(this.key(), { builds, at: this.o.now() }).catch(() => undefined);
  }
}
