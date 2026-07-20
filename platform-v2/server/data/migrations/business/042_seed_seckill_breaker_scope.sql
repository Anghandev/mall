-- A missing seckill breaker row is fail-closed by session creation. Seed only
-- the absent initial state; an existing paused row is authoritative.
INSERT INTO core.circuit_breakers (
    scope, paused, evidence_hash, policy_version, changed_by, changed_at
) VALUES (
    'SECKILL_PURCHASE',
    false,
    '0xdd86f3eb7e31f41bf95f86465026dd2ec8291b88231b8b3f72a4ade0e5764931',
    NULL,
    'MIGRATION:042_SEED_SECKILL_BREAKER_SCOPE',
    clock_timestamp()
)
ON CONFLICT (scope) DO NOTHING;
