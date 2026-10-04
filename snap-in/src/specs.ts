// Workflow specs and engine configuration from install inputs. The spec is bundled by esbuild (JSON import).
import { defineConfig, type EngineConfig } from '../../src/config.ts';
import type { Spec } from '../../src/types.ts';
import desktopRelease from '../../workflows/desktop-release/spec.json';
import { DEFAULT_ALLOWLIST, parseAllowlist } from './slack.ts';

export const SPECS: Spec[] = [desktopRelease as unknown as Spec];

export interface Inputs {
  env: string;
  bot: string;
  own_bot_user: string;
  tony_agent: string;
  wake_user: string;
  wake_workflow: string;
  slack_channel_allowlist: string[];
  github_repo: string;
  mock_branch: string;
  state_path: string;
  guidance_version: string;
  /** R43: operator cleanup list, `<job id>=<reason>` entries separated by `;`. Set only by someone who can edit the installation. */
  admin_close_jobs: string;
}

const text = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim() : d);

/** Read install inputs from the snap-in record; fall back to the QA defaults only where safe. */
export function readInputs(values: Record<string, unknown> = {}): Inputs {
  return {
    env: text(values.env, 'qa'),
    bot: text(values.bot, 'tony'),
    own_bot_user: text(values.own_bot_user, 'U0C4FFYJGE6'),
    tony_agent: text(values.tony_agent, ''),
    wake_user: text(values.wake_user, ''),
    wake_workflow: text(values.wake_workflow, ''),
    slack_channel_allowlist: parseAllowlist(text(values.slack_channel_allowlist, DEFAULT_ALLOWLIST.join(','))),
    github_repo: text(values.github_repo, 'devrev/devrev-web'),
    mock_branch: text(values.mock_branch, 'mock/tony-desktop-release'),
    state_path: text(values.state_path, 'mock-release/state.json'),
    guidance_version: text(values.guidance_version, ''),
    admin_close_jobs: text(values.admin_close_jobs, ''),
  };
}

export function engineConfig(i: Inputs): EngineConfig {
  return defineConfig({ env: i.env, bot: i.bot, ownBotUserId: i.own_bot_user, guidanceVersion: i.guidance_version || undefined });
}

/** `job=reason;job2=reason2`. A job id may contain ':' but not '=' or ';'. Malformed entries are ignored. */
export function parseAdminClose(v: string): Array<{ job: string; reason: string }> {
  const out: Array<{ job: string; reason: string }> = [];
  for (const part of v.split(';')) {
    const i = part.indexOf('=');
    const job = (i < 0 ? part : part.slice(0, i)).trim();
    if (!job) continue;
    out.push({ job, reason: (i < 0 ? '' : part.slice(i + 1)).trim() || 'operator cleanup' });
  }
  return out;
}
