// GitHub SourceReader. GET only, one repo, one ref. The token (keyring github_read) is broader than the mock branch,
// so the restriction lives here. Any error returns null, which the engine treats as source_unreadable.
import type { SourceReader } from '../../src/types.ts';
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
    if (route.startsWith('commits/')) { if (route !== `commits/${this.o.branch}`) throw new GithubSourceError('ref not allowed'); }
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
      const c = await this.get(`/repos/${this.o.repo}/commits/${encodeURIComponent(this.o.branch)}`);
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
