ALTER TABLE core.ledger_journals
    DROP CONSTRAINT ledger_journals_event_type_check,
    DROP CONSTRAINT ledger_journals_reversal_check;

ALTER TABLE core.ledger_journals
    ADD CONSTRAINT ledger_journals_event_type_check CHECK (event_type IN (
        'PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL',
        'ARBITRATION_DISPUTED', 'ARBITRATION_RESOLVED', 'FULFILLMENT_AVAILABLE',
        'SETTLEMENT_REQUESTED', 'SETTLEMENT_SUBMITTED', 'SETTLEMENT_SETTLED',
        'SETTLEMENT_EXECUTION_REVERSED', 'SETTLEMENT_FINALITY_REVERSED',
        'GUARANTEE_DEPOSITED', 'GUARANTEE_DEDUCTED',
        'TAKEOVER_FUNDED', 'MERCHANT_DEBT_CAPTURED', 'FUTURE_PROCEEDS_CAPTURED',
        'COVERAGE_RECONCILED', 'SECKILL_PRIZE_INJECTED',
        'SECKILL_PRIZE_INJECTION_REVERSED', 'SECKILL_PRIZE_AWARDED',
        'SECKILL_PRIZE_AWARD_REVERSED', 'SECKILL_PRIZE_ROLLED_OVER',
        'SECKILL_PRIZE_FUNDING_RECALLED', 'SECKILL_PRIZE_DEFICIT_RECOVERED',
        'SECKILL_PRIZE_PAYOUT_RECOVERY_REVERSED',
        'SECKILL_PRIZE_REORG_REMAINDER_ROLLED_OVER'
    )),
    ADD CONSTRAINT ledger_journals_reversal_check CHECK (
        (event_type IN (
            'PAYMENT_REORG_REVERSAL',
            'SECKILL_PRIZE_INJECTION_REVERSED',
            'SECKILL_PRIZE_AWARD_REVERSED'
        )) = (reversal_of IS NOT NULL)
    );

ALTER TABLE core.ledger_accounts
    DROP CONSTRAINT ledger_accounts_purpose_check;

ALTER TABLE core.ledger_accounts
    ADD CONSTRAINT ledger_accounts_purpose_check CHECK (purpose IN (
        'WALLET_ASSET', 'PAYMENT_CLEARING', 'BURN', 'MERCHANT_RECEIVABLE',
        'MERCHANT_FREIGHT_RECEIVABLE', 'PLATFORM_SERVICE_FEE_REVENUE',
        'CONCESSION', 'POLICY_ALLOCATION', 'SECKILL_PRIZE_LIABILITY',
        'SECKILL_PRIZE_REORG_DEFICIT',
        'NODE_REWARD_POOL', 'REWARD_RESERVE_POOL',
        'REWARD_LIABILITY', 'BNM_ISSUANCE', 'BNM_LIABILITY',
        'GUARANTEE_ASSET', 'GUARANTEE_LIABILITY', 'MERCHANT_DEBT_RECEIVABLE',
        'TAKEOVER_PAYABLE', 'OPERATIONS_ADVANCE_ASSET',
        'OPERATIONS_REIMBURSEMENT', 'SETTLEMENT_CLEARING'
    ));

CREATE TABLE core.seckill_prize_reorg_exposures (
    exposure_id text PRIMARY KEY CHECK (exposure_id ~ '^0x[0-9a-f]{64}$'),
    funding_kind text NOT NULL CHECK (funding_kind IN (
        'INJECTION', 'PAYMENT_CONTRIBUTION', 'PAYOUT_RECOVERY'
    )),
    funding_id text NOT NULL,
    source_session_id text NOT NULL REFERENCES core.seckill_sessions(session_id),
    liability_session_id text NOT NULL REFERENCES core.seckill_sessions(session_id),
    amount_usdt numeric(78, 0) NOT NULL CHECK (amount_usdt > 0),
    settlement_wallet_address text NOT NULL CHECK (
        settlement_wallet_address ~ '^0x[0-9a-f]{40}$'
    ),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    source_tx_hash text NOT NULL CHECK (source_tx_hash ~ '^0x[0-9a-f]{64}$'),
    source_block_hash text NOT NULL CHECK (source_block_hash ~ '^0x[0-9a-f]{64}$'),
    resolution_mode text NOT NULL CHECK (resolution_mode IN ('STANDARD_REVERSAL', 'DEFICIT_MONITORING')),
    payout_snapshot jsonb NOT NULL CHECK (jsonb_typeof(payout_snapshot) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (funding_kind, funding_id, evidence_hash)
);

CREATE TABLE core.seckill_prize_reorg_transitions (
    transition_id text PRIMARY KEY CHECK (transition_id ~ '^0x[0-9a-f]{64}$'),
    exposure_id text NOT NULL REFERENCES core.seckill_prize_reorg_exposures(exposure_id),
    transition_type text NOT NULL CHECK (transition_type IN (
        'QUARANTINED', 'FUNDING_REVERSED', 'PAYOUT_FINAL', 'PAYOUT_FAILED', 'PAYOUT_REORGED',
        'REMAINDER_RECOVERABLE', 'REMAINDER_ROLLED_OVER',
        'RESOLVED', 'BREAKER_RESUMED'
    )),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL
);

CREATE INDEX seckill_prize_reorg_transitions_exposure_idx
    ON core.seckill_prize_reorg_transitions (exposure_id, created_at, transition_id);

CREATE TABLE core.seckill_prize_reorg_remainders (
    remainder_id text PRIMARY KEY CHECK (remainder_id ~ '^0x[0-9a-f]{64}$'),
    exposure_id text NOT NULL REFERENCES core.seckill_prize_reorg_exposures(exposure_id),
    recovery_episode bigint NOT NULL CHECK (recovery_episode > 0),
    session_id text NOT NULL REFERENCES core.seckill_sessions(session_id),
    amount_usdt numeric(78, 0) NOT NULL CHECK (amount_usdt > 0),
    settlement_wallet_address text NOT NULL CHECK (
        settlement_wallet_address ~ '^0x[0-9a-f]{40}$'
    ),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('PENDING', 'ROLLED_OVER', 'SUPERSEDED')),
    target_session_id text REFERENCES core.seckill_sessions(session_id),
    rollover_journal_id text UNIQUE REFERENCES core.ledger_journals(journal_id),
    created_at timestamptz NOT NULL,
    resolved_at timestamptz,
    CHECK (
        (state = 'PENDING' AND target_session_id IS NULL
            AND rollover_journal_id IS NULL AND resolved_at IS NULL)
        OR (state = 'ROLLED_OVER' AND target_session_id IS NOT NULL
            AND rollover_journal_id IS NOT NULL AND resolved_at IS NOT NULL)
        OR (state = 'SUPERSEDED' AND target_session_id IS NULL
            AND rollover_journal_id IS NULL AND resolved_at IS NOT NULL)
    ),
    CHECK (target_session_id IS NULL OR target_session_id <> session_id),
    UNIQUE (exposure_id, recovery_episode)
);

CREATE INDEX seckill_prize_reorg_remainders_pending_idx
    ON core.seckill_prize_reorg_remainders (state, session_id, created_at, remainder_id);

CREATE TABLE core.seckill_prize_reorg_recoveries (
    recovery_id text PRIMARY KEY CHECK (recovery_id ~ '^0x[0-9a-f]{64}$'),
    exposure_id text NOT NULL REFERENCES core.seckill_prize_reorg_exposures(exposure_id),
    recovery_episode bigint NOT NULL CHECK (recovery_episode > 0),
    coverage_snapshot_id text NOT NULL REFERENCES core.coverage_snapshots(snapshot_id),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    secondary_signer text NOT NULL CHECK (secondary_signer ~ '^0x[0-9a-f]{40}$'),
    secondary_signature_hash text NOT NULL CHECK (secondary_signature_hash ~ '^0x[0-9a-f]{64}$'),
    approval_nonce numeric(78, 0) NOT NULL CHECK (approval_nonce >= 0),
    approval_deadline timestamptz NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (exposure_id, recovery_episode),
    UNIQUE (secondary_signer, approval_nonce)
);

CREATE FUNCTION core.protect_seckill_prize_reorg_remainder_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.remainder_id IS DISTINCT FROM OLD.remainder_id
        OR NEW.exposure_id IS DISTINCT FROM OLD.exposure_id
        OR NEW.recovery_episode IS DISTINCT FROM OLD.recovery_episode
        OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.amount_usdt IS DISTINCT FROM OLD.amount_usdt
        OR NEW.settlement_wallet_address IS DISTINCT FROM OLD.settlement_wallet_address
        OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'ImmutableSeckillPrizeReorgRemainderIdentity' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER seckill_prize_reorg_exposures_no_mutation
    BEFORE UPDATE OR DELETE ON core.seckill_prize_reorg_exposures
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER seckill_prize_reorg_transitions_no_mutation
    BEFORE UPDATE OR DELETE ON core.seckill_prize_reorg_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER seckill_prize_reorg_remainders_identity_immutable
    BEFORE UPDATE ON core.seckill_prize_reorg_remainders
    FOR EACH ROW EXECUTE FUNCTION core.protect_seckill_prize_reorg_remainder_identity();

CREATE TRIGGER seckill_prize_reorg_remainders_no_delete
    BEFORE DELETE ON core.seckill_prize_reorg_remainders
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER seckill_prize_reorg_recoveries_no_mutation
    BEFORE UPDATE OR DELETE ON core.seckill_prize_reorg_recoveries
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
