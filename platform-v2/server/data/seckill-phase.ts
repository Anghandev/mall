import { CoreError } from '../api/errors.ts';

export type StoredSeckillPhase = 'PREHEAT' | 'LIVE' | 'SETTLING' | 'SETTLED' | 'FORCE_CLOSED';
export type EffectiveSeckillPhase = StoredSeckillPhase;

export interface SeckillPhaseSource {
  phase: StoredSeckillPhase;
  starts_at: Date | string;
  main_deadline: Date | string;
  relay_deadline: Date | string;
}

export function effectiveSeckillPhase(row: SeckillPhaseSource, now: Date): EffectiveSeckillPhase {
  if (row.phase === 'FORCE_CLOSED' || row.phase === 'SETTLED') return row.phase;
  const startsAt = timestamp(row.starts_at);
  const mainDeadline = timestamp(row.main_deadline);
  const relayDeadline = timestamp(row.relay_deadline);
  if (now < startsAt) return 'PREHEAT';
  if (now < mainDeadline && now < relayDeadline) return 'LIVE';
  return 'SETTLING';
}

export function blocksOrdinaryQuote(row: SeckillPhaseSource, now: Date) {
  return ['PREHEAT', 'LIVE', 'SETTLING'].includes(effectiveSeckillPhase(row, now));
}

function timestamp(value: Date | string) {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new CoreError('UnknownState', 'Seckill timestamp projection is invalid', 409);
  }
  return result;
}
