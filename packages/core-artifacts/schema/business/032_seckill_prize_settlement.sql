ALTER TABLE core.ledger_journals
    DROP CONSTRAINT ledger_journals_event_type_check,
    DROP CONSTRAINT ledger_journals_reversal_check;

ALTER TABLE core.ledger_journals
    ADD CONSTRAINT ledger_journals_event_type_check CHECK (event_type IN (
        'PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL',
        'ARBITRATION_DISPUTED', 'ARBITRATION_RESOLVED', 'FULFILLMENT_AVAILABLE',
        'SETTLEMENT_REQUESTED', 'SETTLEMENT_BATCHED', 'SETTLEMENT_SETTLED',
        'SETTLEMENT_BATCH_REVERSED', 'SETTLEMENT_FINALITY_REVERSED',
        'GUARANTEE_DEPOSITED', 'GUARANTEE_DEDUCTED',
        'TAKEOVER_FUNDED', 'MERCHANT_DEBT_CAPTURED', 'FUTURE_PROCEEDS_CAPTURED',
        'COVERAGE_RECONCILED', 'SECKILL_PRIZE_INJECTED',
        'SECKILL_PRIZE_INJECTION_REVERSED', 'SECKILL_PRIZE_AWARDED',
        'SECKILL_PRIZE_ROLLED_OVER'
    )),
    ADD CONSTRAINT ledger_journals_reversal_check CHECK (
        (event_type IN ('PAYMENT_REORG_REVERSAL', 'SECKILL_PRIZE_INJECTION_REVERSED'))
            = (reversal_of IS NOT NULL)
    );

CREATE TABLE core.seckill_prize_contributions (
    order_id text PRIMARY KEY REFERENCES core.orders(order_id),
    session_id text NOT NULL REFERENCES core.seckill_sessions(session_id),
    payment_event_key text NOT NULL UNIQUE REFERENCES core.payment_events(event_key),
    account_id text NOT NULL REFERENCES core.ledger_accounts(account_id),
    amount_usdt numeric(78, 0) NOT NULL CHECK (amount_usdt > 0),
    created_at timestamptz NOT NULL,
    reversed_at timestamptz,
    reversal_event_key text UNIQUE,
    CHECK ((reversed_at IS NULL) = (reversal_event_key IS NULL))
);

CREATE INDEX seckill_prize_contributions_session_idx
    ON core.seckill_prize_contributions (session_id, created_at, order_id)
    WHERE reversed_at IS NULL;

CREATE TABLE core.seckill_prize_settlements (
    session_id text PRIMARY KEY REFERENCES core.seckill_sessions(session_id),
    cutoff_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN (
        'REVIEW_PENDING', 'APPROVED', 'ROLLOVER_PENDING', 'ROLLED_OVER', 'QUARANTINED'
    )),
    candidate_order_id text REFERENCES core.orders(order_id),
    candidate_buyer_wallet text CHECK (
        candidate_buyer_wallet IS NULL OR candidate_buyer_wallet ~ '^0x[0-9a-f]{40}$'
    ),
    candidate_payment_event_key text REFERENCES core.payment_events(event_key),
    candidate_block_number bigint CHECK (candidate_block_number IS NULL OR candidate_block_number >= 0),
    candidate_log_index bigint CHECK (candidate_log_index IS NULL OR candidate_log_index >= 0),
    candidate_evidence_hash text CHECK (
        candidate_evidence_hash IS NULL OR candidate_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    pool_amount_usdt numeric(78, 0) NOT NULL CHECK (pool_amount_usdt >= 0),
    pool_snapshot_hash text NOT NULL UNIQUE CHECK (pool_snapshot_hash ~ '^0x[0-9a-f]{64}$'),
    review_decision text CHECK (review_decision IN ('APPROVED', 'REJECTED')),
    review_reason_code text,
    review_evidence_hash text CHECK (
        review_evidence_hash IS NULL OR review_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    reviewed_by text CHECK (reviewed_by IS NULL OR reviewed_by ~ '^0x[0-9a-f]{40}$'),
    reviewed_at timestamptz,
    review_idempotency_key text,
    review_request_hash text CHECK (
        review_request_hash IS NULL OR review_request_hash ~ '^0x[0-9a-f]{64}$'
    ),
    award_account_id text REFERENCES core.ledger_accounts(account_id),
    award_journal_id text UNIQUE REFERENCES core.ledger_journals(journal_id),
    rollover_target_session_id text REFERENCES core.seckill_sessions(session_id),
    rollover_journal_id text UNIQUE REFERENCES core.ledger_journals(journal_id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (
        (candidate_order_id IS NULL AND candidate_buyer_wallet IS NULL
            AND candidate_payment_event_key IS NULL AND candidate_block_number IS NULL
            AND candidate_log_index IS NULL AND candidate_evidence_hash IS NULL)
        OR
        (candidate_order_id IS NOT NULL AND candidate_buyer_wallet IS NOT NULL
            AND candidate_payment_event_key IS NOT NULL AND candidate_block_number IS NOT NULL
            AND candidate_log_index IS NOT NULL AND candidate_evidence_hash IS NOT NULL)
    ),
    CHECK (state <> 'REVIEW_PENDING' OR (candidate_order_id IS NOT NULL AND review_decision IS NULL)),
    CHECK (state <> 'APPROVED' OR review_decision = 'APPROVED'),
    CHECK (review_decision <> 'APPROVED' OR state IN ('APPROVED', 'QUARANTINED')),
    CHECK (review_decision IS NULL OR (
        review_reason_code IS NOT NULL AND review_evidence_hash IS NOT NULL
        AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
        AND review_idempotency_key IS NOT NULL AND review_request_hash IS NOT NULL
    )),
    CHECK ((award_journal_id IS NULL) = (award_account_id IS NULL)),
    CHECK (state <> 'APPROVED' OR pool_amount_usdt = 0 OR award_journal_id IS NOT NULL),
    CHECK ((rollover_journal_id IS NULL) = (rollover_target_session_id IS NULL)),
    CHECK (state <> 'ROLLED_OVER' OR pool_amount_usdt = 0 OR rollover_journal_id IS NOT NULL),
    CHECK (rollover_target_session_id IS NULL OR rollover_target_session_id <> session_id)
);

CREATE TABLE core.seckill_prize_settlement_events (
    event_id text PRIMARY KEY CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
    session_id text NOT NULL REFERENCES core.seckill_prize_settlements(session_id),
    event_type text NOT NULL CHECK (event_type IN (
        'WINNER_FROZEN', 'EMPTY_SESSION', 'REVIEW_APPROVED', 'REVIEW_REJECTED',
        'ROLLED_OVER', 'QUARANTINED'
    )),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    actor_wallet text CHECK (actor_wallet IS NULL OR actor_wallet ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL
);

CREATE FUNCTION core.protect_seckill_prize_settlement_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.cutoff_at IS DISTINCT FROM OLD.cutoff_at
        OR NEW.candidate_order_id IS DISTINCT FROM OLD.candidate_order_id
        OR NEW.candidate_buyer_wallet IS DISTINCT FROM OLD.candidate_buyer_wallet
        OR NEW.candidate_payment_event_key IS DISTINCT FROM OLD.candidate_payment_event_key
        OR NEW.candidate_block_number IS DISTINCT FROM OLD.candidate_block_number
        OR NEW.candidate_log_index IS DISTINCT FROM OLD.candidate_log_index
        OR NEW.candidate_evidence_hash IS DISTINCT FROM OLD.candidate_evidence_hash
        OR NEW.pool_amount_usdt IS DISTINCT FROM OLD.pool_amount_usdt
        OR NEW.pool_snapshot_hash IS DISTINCT FROM OLD.pool_snapshot_hash
    THEN
        RAISE EXCEPTION 'ImmutableSeckillPrizeSnapshot' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER seckill_prize_settlements_snapshot_immutable
    BEFORE UPDATE ON core.seckill_prize_settlements
    FOR EACH ROW EXECUTE FUNCTION core.protect_seckill_prize_settlement_snapshot();
CREATE TRIGGER seckill_prize_settlements_no_delete
    BEFORE DELETE ON core.seckill_prize_settlements
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER seckill_prize_settlement_events_no_mutation
    BEFORE UPDATE OR DELETE ON core.seckill_prize_settlement_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER seckill_prize_contributions_no_delete
    BEFORE DELETE ON core.seckill_prize_contributions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
