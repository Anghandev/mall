import { merchantLevels, type MerchantLevel } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { SqlExecutor } from './migrations.ts';

export interface MerchantLevelRule {
  level: MerchantLevel;
  maxProductSettlementUsdt: string;
  monthlySeckillQuota: number;
}

export interface MerchantLevelPolicy {
  configVersionId: string;
  version: number;
  effectiveFrom: Date;
  levels: readonly MerchantLevelRule[];
}

export function validateMerchantLevelPayload(value: unknown) {
  const input = record(value, 'merchant level config');
  assertOnlyKeys(input, ['levels']);
  if (!Array.isArray(input.levels) || input.levels.length !== merchantLevels.length) {
    throw new CoreError('InvalidRequest', 'Merchant level config must contain V1-V5 exactly once');
  }
  const rules = input.levels.map((item) => {
    const rule = record(item, 'merchant level rule');
    assertOnlyKeys(rule, ['level', 'maxProductSettlementUsdt', 'monthlySeckillQuota']);
    if (!merchantLevels.includes(rule.level as MerchantLevel)) {
      throw new CoreError('InvalidRequest', 'Merchant level rule has an unknown level');
    }
    const maximum = atomic(rule.maxProductSettlementUsdt, 'merchant product settlement maximum');
    if (maximum === '0') throw new CoreError('InvalidRequest', 'Merchant product settlement maximum must be positive');
    if (!Number.isSafeInteger(rule.monthlySeckillQuota) || Number(rule.monthlySeckillQuota) < 0) {
      throw new CoreError('InvalidRequest', 'Merchant monthly seckill quota must be a non-negative integer');
    }
    return {
      level: rule.level as MerchantLevel,
      maxProductSettlementUsdt: maximum,
      monthlySeckillQuota: Number(rule.monthlySeckillQuota),
    };
  });
  if (new Set(rules.map((rule) => rule.level)).size !== merchantLevels.length) {
    throw new CoreError('InvalidRequest', 'Merchant level config contains duplicate levels');
  }
  const byLevel = new Map(rules.map((rule) => [rule.level, rule]));
  return Object.freeze({
    levels: Object.freeze(merchantLevels.map((level) => Object.freeze(byLevel.get(level)!))),
  });
}

export async function currentMerchantLevelPolicy(executor: SqlExecutor): Promise<MerchantLevelPolicy> {
  const result = await executor.query<{
    config_version_id: string;
    version: number;
    effective_from: Date;
    payload: unknown;
  }>(
    `SELECT config_version_id, version, effective_from, payload
     FROM core.current_system_config WHERE config_key = 'MERCHANT_LEVELS'`,
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('DecisionBlocked', 'Published V1-V5 merchant limits are unavailable', 409);
  const payload = validateMerchantLevelPayload(row.payload);
  return Object.freeze({
    configVersionId: row.config_version_id,
    version: Number(row.version),
    effectiveFrom: new Date(row.effective_from),
    levels: payload.levels,
  });
}

export function merchantLevelRule(policy: MerchantLevelPolicy, level: MerchantLevel) {
  const rule = policy.levels.find((item) => item.level === level);
  if (!rule) throw new CoreError('DecisionBlocked', `Published ${level} merchant limits are unavailable`, 409);
  return rule;
}

export function shanghaiMonth(value: Date) {
  const shifted = new Date(value.getTime() + 8 * 60 * 60_000);
  const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - 8 * 60 * 60_000);
  const end = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - 8 * 60 * 60_000);
  return Object.freeze({ start, end });
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('InvalidRequest', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    throw new CoreError('InvalidRequest', 'Merchant level config contains unknown or missing fields');
  }
}

function atomic(value: unknown, name: string) {
  const result = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return result;
}
