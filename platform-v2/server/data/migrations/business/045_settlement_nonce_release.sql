ALTER TABLE core.settlement_transfers
    ADD COLUMN nonce_state text NOT NULL DEFAULT 'RESERVED',
    ADD COLUMN nonce_release_evidence_hash text;

UPDATE core.settlement_transfers transfer
SET nonce_state = CASE
        WHEN transfer.state IN ('SUBMITTED', 'MINED', 'SETTLED', 'REORGED', 'FAILED', 'QUARANTINED')
            THEN 'BROADCAST'
        ELSE 'RESERVED'
    END,
    nonce_release_evidence_hash = NULL;

ALTER TABLE core.settlement_transfers
    ADD CONSTRAINT settlement_transfers_nonce_state_check CHECK (
        nonce_state IN ('RESERVED', 'BROADCAST', 'RELEASED')
    ),
    ADD CONSTRAINT settlement_transfers_nonce_release_check CHECK (
        (nonce_state = 'RELEASED'
            AND state = 'QUARANTINED'
            AND nonce_release_evidence_hash ~ '^0x[0-9a-f]{64}$')
        OR (nonce_state <> 'RELEASED' AND nonce_release_evidence_hash IS NULL)
    );

ALTER TABLE core.settlement_transfers
    DROP CONSTRAINT settlement_transfers_executor_wallet_executor_nonce_key;

CREATE UNIQUE INDEX settlement_transfers_active_executor_nonce_idx
    ON core.settlement_transfers (executor_wallet, executor_nonce)
    WHERE nonce_state <> 'RELEASED';

CREATE FUNCTION core.protect_settlement_transfer_nonce() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.nonce_state IS DISTINCT FROM OLD.nonce_state AND NOT (
        OLD.nonce_state = 'RESERVED'
        AND NEW.nonce_state IN ('BROADCAST', 'RELEASED')
    ) THEN
        RAISE EXCEPTION 'InvalidSettlementNonceTransition' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.nonce_release_evidence_hash IS DISTINCT FROM OLD.nonce_release_evidence_hash AND NOT (
        OLD.nonce_release_evidence_hash IS NULL
        AND NEW.nonce_state = 'RELEASED'
        AND NEW.nonce_release_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ) THEN
        RAISE EXCEPTION 'InvalidSettlementNonceTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER settlement_transfers_nonce_integrity
    BEFORE UPDATE ON core.settlement_transfers
    FOR EACH ROW EXECUTE FUNCTION core.protect_settlement_transfer_nonce();

ALTER TABLE core.seckill_governance_actions
    ADD COLUMN nonce_reserved_at timestamptz,
    ADD COLUMN nonce_reservation_evidence_hash text,
    ADD COLUMN execution_artifact_version text,
    ADD COLUMN execution_request_digest text,
    ADD COLUMN nonce_released_at timestamptz,
    ADD COLUMN nonce_release_evidence_hash text;

UPDATE core.seckill_governance_actions
SET nonce_reserved_at = updated_at,
    nonce_reservation_evidence_hash = execution_evidence_hash
WHERE executor_nonce IS NOT NULL;

ALTER TABLE core.seckill_governance_actions
    DROP CONSTRAINT seckill_governance_actions_execution_state_check,
    DROP CONSTRAINT seckill_governance_actions_state_eoa_check,
    ADD CONSTRAINT seckill_governance_actions_state_eoa_check CHECK (state IN (
        'DRAFT', 'SECONDARY_SIGNED', 'PENDING_EXECUTION', 'SUBMITTED',
        'MINED', 'FINAL', 'REORGED', 'FAILED', 'CANCELLED', 'RECONCILE_REQUIRED'
    )),
    ADD CONSTRAINT seckill_governance_actions_nonce_reservation_evidence_check CHECK (
        nonce_reservation_evidence_hash IS NULL
        OR nonce_reservation_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT seckill_governance_actions_execution_request_digest_check CHECK (
        execution_request_digest IS NULL OR execution_request_digest ~ '^0x[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT seckill_governance_actions_nonce_release_evidence_check CHECK (
        nonce_release_evidence_hash IS NULL OR nonce_release_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT seckill_governance_actions_execution_state_check CHECK (
        (state IN ('DRAFT', 'SECONDARY_SIGNED')
            AND executor_nonce IS NULL
            AND nonce_reserved_at IS NULL
            AND nonce_reservation_evidence_hash IS NULL
            AND execution_artifact_version IS NULL
            AND execution_request_digest IS NULL
            AND nonce_released_at IS NULL
            AND nonce_release_evidence_hash IS NULL
            AND submitted_tx_hash IS NULL
            AND execution_evidence_hash IS NULL)
        OR (state = 'CANCELLED' AND (
            (executor_nonce IS NULL
                AND nonce_reserved_at IS NULL
                AND nonce_reservation_evidence_hash IS NULL
                AND execution_artifact_version IS NULL
                AND execution_request_digest IS NULL
                AND nonce_released_at IS NULL
                AND nonce_release_evidence_hash IS NULL)
            OR (executor_nonce IS NOT NULL
                AND nonce_reserved_at IS NOT NULL
                AND nonce_reservation_evidence_hash IS NOT NULL
                AND execution_artifact_version IS NOT NULL
                AND execution_request_digest IS NOT NULL
                AND nonce_released_at IS NOT NULL
                AND nonce_release_evidence_hash IS NOT NULL)
            )
            AND submitted_tx_hash IS NULL
            AND execution_evidence_hash IS NULL)
        OR (state = 'PENDING_EXECUTION'
            AND nonce_released_at IS NULL
            AND nonce_release_evidence_hash IS NULL
            AND submitted_tx_hash IS NULL
            AND execution_evidence_hash IS NULL
            AND (
                (executor_nonce IS NULL
                    AND nonce_reserved_at IS NULL
                    AND nonce_reservation_evidence_hash IS NULL
                    AND execution_artifact_version IS NULL
                    AND execution_request_digest IS NULL)
                OR (executor_nonce IS NOT NULL
                    AND nonce_reserved_at IS NOT NULL
                    AND nonce_reservation_evidence_hash IS NOT NULL
                    AND execution_artifact_version IS NOT NULL
                    AND execution_request_digest IS NOT NULL)
            ))
        OR (state = 'RECONCILE_REQUIRED'
            AND executor_nonce IS NOT NULL
            AND nonce_reserved_at IS NOT NULL
            AND nonce_reservation_evidence_hash IS NOT NULL
            AND execution_artifact_version IS NOT NULL
            AND execution_request_digest IS NOT NULL
            AND nonce_released_at IS NULL
            AND nonce_release_evidence_hash IS NULL
            AND submitted_tx_hash IS NULL
            AND execution_evidence_hash IS NULL)
        OR (state IN ('SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'FAILED')
            AND executor_nonce IS NOT NULL
            AND nonce_reserved_at IS NOT NULL
            AND nonce_reservation_evidence_hash IS NOT NULL
            AND nonce_released_at IS NULL
            AND nonce_release_evidence_hash IS NULL
            AND (
                (execution_artifact_version IS NULL AND execution_request_digest IS NULL)
                OR (execution_artifact_version IS NOT NULL AND execution_request_digest IS NOT NULL)
            )
            AND submitted_tx_hash IS NOT NULL
            AND execution_evidence_hash IS NOT NULL)
    );

DROP INDEX core.seckill_governance_actions_executor_nonce_idx;
CREATE UNIQUE INDEX seckill_governance_actions_executor_nonce_idx
    ON core.seckill_governance_actions (governance_wallet_address, executor_nonce)
    WHERE executor_nonce IS NOT NULL AND nonce_release_evidence_hash IS NULL;

DROP INDEX core.seckill_governance_actions_pending_idx;
CREATE INDEX seckill_governance_actions_pending_idx
    ON core.seckill_governance_actions (state, updated_at, action_id)
    WHERE state IN ('PENDING_EXECUTION', 'RECONCILE_REQUIRED', 'SUBMITTED', 'MINED', 'FINAL');

CREATE FUNCTION core.protect_seckill_executor_nonce_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.executor_nonce IS DISTINCT FROM OLD.executor_nonce AND NOT (
        OLD.state = 'PENDING_EXECUTION'
        AND NEW.state = 'PENDING_EXECUTION'
        AND OLD.executor_nonce IS NULL
        AND NEW.executor_nonce IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'InvalidSeckillNonceTransition' USING ERRCODE = 'P0001';
    END IF;
    IF (
        NEW.nonce_reserved_at IS DISTINCT FROM OLD.nonce_reserved_at
        OR NEW.nonce_reservation_evidence_hash IS DISTINCT FROM OLD.nonce_reservation_evidence_hash
        OR NEW.execution_artifact_version IS DISTINCT FROM OLD.execution_artifact_version
        OR NEW.execution_request_digest IS DISTINCT FROM OLD.execution_request_digest
    ) AND NOT (
        OLD.state = 'PENDING_EXECUTION'
        AND NEW.state = 'PENDING_EXECUTION'
        AND OLD.nonce_reserved_at IS NULL
        AND OLD.nonce_reservation_evidence_hash IS NULL
        AND NEW.executor_nonce IS NOT NULL
        AND NEW.nonce_reserved_at IS NOT NULL
        AND NEW.nonce_reservation_evidence_hash ~ '^0x[0-9a-f]{64}$'
        AND NEW.execution_artifact_version IS NOT NULL
        AND NEW.execution_request_digest ~ '^0x[0-9a-f]{64}$'
    ) THEN
        RAISE EXCEPTION 'InvalidSeckillNonceTransition' USING ERRCODE = 'P0001';
    END IF;
    IF (
        NEW.nonce_released_at IS DISTINCT FROM OLD.nonce_released_at
        OR NEW.nonce_release_evidence_hash IS DISTINCT FROM OLD.nonce_release_evidence_hash
    ) AND NOT (
        OLD.state = 'PENDING_EXECUTION'
        AND NEW.state = 'CANCELLED'
        AND OLD.executor_nonce IS NOT NULL
        AND NEW.executor_nonce = OLD.executor_nonce
        AND OLD.nonce_released_at IS NULL
        AND OLD.nonce_release_evidence_hash IS NULL
        AND NEW.nonce_released_at IS NOT NULL
        AND NEW.nonce_release_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ) THEN
        RAISE EXCEPTION 'InvalidSeckillNonceTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER seckill_executor_nonce_reservation_integrity
    BEFORE UPDATE ON core.seckill_governance_actions
    FOR EACH ROW EXECUTE FUNCTION core.protect_seckill_executor_nonce_reservation();
