import type { CheckMode, CheckName } from './types.ts';

export const CHECK_NAMES: readonly CheckName[] = [
  'superseded_run',
  'job_cancelled',
  'lease_held',
  'build_changed',
  'sender_not_listed',
];

export interface EngineConfig {
  env: string;
  bot: string;
  ownBotUserId: string;
  /** The one place hold or flag is set per check. missing_session is never configurable. */
  checks: Record<CheckName, CheckMode>;
  runTimeoutMinutes: number;
  sweepMinutes: number;
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
  };
}
