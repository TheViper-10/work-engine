import type { CheckMode, CheckName } from './types.ts';

export const CHECK_NAMES: readonly CheckName[] = [
  'superseded_run',
  'job_cancelled',
  'lease_held',
  'build_changed',
  'no_go_for_build',
  'sender_not_listed',
];

/**
 * Decision R31 (revised by R69): the pilot's check modes, in one place. The snap-in ships this set (snap-in/src/specs.ts) and the
 * harness (`--checks deploy`) builds its engine from the snap-in's config, so the two cannot diverge. Reversible config: change a value here.
 * R69: `sender_not_listed` holds, because a go from anyone not listed for a consequential gate must not be able to approve it (live run 3).
 */
export const DEPLOY_CHECKS: Readonly<Record<CheckName, CheckMode>> = {
  build_changed: 'hold',
  no_go_for_build: 'hold',
  job_cancelled: 'hold',
  superseded_run: 'hold',
  lease_held: 'flag',
  sender_not_listed: 'hold',
};

export interface EngineConfig {
  env: string;
  bot: string;
  ownBotUserId: string;
  /** The one place hold or flag is set per check. missing_session is never configurable. */
  checks: Record<CheckName, CheckMode>;
  runTimeoutMinutes: number;
  sweepMinutes: number;
  /** A2: minutes of unconfirmed attempts with no confirmed owner call before the job records escalate. */
  identityEscalateMinutes: number;
  /** A4: at most one notice into an active home per this many minutes. */
  noticeCoalesceMinutes: number;
  /** A4: unprocessed inbox items above this bound coalesce plain messages into one overflow item. */
  inboxMaxUnprocessed: number;
  /** R24: version of the agent guidance, recorded on each job at open. */
  guidanceVersion?: string;
}

export type EngineConfigInput = Pick<EngineConfig, 'env' | 'bot' | 'ownBotUserId'> &
  Partial<Omit<EngineConfig, 'checks'>> & { checks?: Partial<Record<string, CheckMode>> };

export function defineConfig(input: EngineConfigInput): EngineConfig {
  const checks = {} as Record<CheckName, CheckMode>;
  for (const name of CHECK_NAMES) {
    const v = input.checks?.[name];
    checks[name] = v === 'hold' ? 'hold' : 'flag';
  }
  return {
    env: input.env,
    bot: input.bot,
    ownBotUserId: input.ownBotUserId,
    checks,
    runTimeoutMinutes: input.runTimeoutMinutes ?? 20,
    sweepMinutes: input.sweepMinutes ?? 5,
    identityEscalateMinutes: input.identityEscalateMinutes ?? 30,
    noticeCoalesceMinutes: input.noticeCoalesceMinutes ?? 2,
    inboxMaxUnprocessed: input.inboxMaxUnprocessed ?? 50,
    guidanceVersion: input.guidanceVersion,
  };
}
