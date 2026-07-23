ALTER TABLE core.settlement_requests
    DROP CONSTRAINT settlement_requests_state_eoa_check;

ALTER TABLE core.settlement_requests
    ADD CONSTRAINT settlement_requests_state_eoa_check CHECK (
        state IN ('REQUESTED', 'SUBMITTED', 'SETTLED', 'RETRYABLE', 'QUARANTINED', 'FAILED_CLOSED')
    );

ALTER TABLE core.settlement_transfers
    DROP CONSTRAINT settlement_transfers_state_check,
    DROP CONSTRAINT settlement_transfers_nonce_release_check;

ALTER TABLE core.settlement_transfers
    ADD CONSTRAINT settlement_transfers_state_check CHECK (state IN (
        'PENDING', 'LEASED', 'SUBMITTED', 'MINED', 'SETTLED',
        'FAILED', 'RETRYABLE', 'REORGED', 'QUARANTINED', 'FAILED_CLOSED'
    )),
    ADD CONSTRAINT settlement_transfers_nonce_release_check CHECK (
        (nonce_state = 'RELEASED'
            AND state IN ('QUARANTINED', 'FAILED_CLOSED')
            AND nonce_release_evidence_hash ~ '^0x[0-9a-f]{64}$')
        OR (nonce_state <> 'RELEASED' AND nonce_release_evidence_hash IS NULL)
    );

ALTER TABLE core.settlement_transfer_attempts
    DROP CONSTRAINT settlement_transfer_attempts_state_check;

ALTER TABLE core.settlement_transfer_attempts
    ADD CONSTRAINT settlement_transfer_attempts_state_check CHECK (state IN (
        'LEASED', 'SUBMITTED', 'MINED', 'SETTLED', 'REPLACED',
        'FAILED', 'RETRYABLE', 'REORGED', 'QUARANTINED', 'FAILED_CLOSED'
    ));

ALTER TABLE core.settlement_request_item_transitions
    DROP CONSTRAINT settlement_request_item_transitions_type_check;

ALTER TABLE core.settlement_request_item_transitions
    ADD CONSTRAINT settlement_request_item_transitions_type_check CHECK (transition_type IN (
        'REQUESTED', 'SUBMITTED', 'SETTLED', 'EXECUTION_REVERSED', 'FINALITY_REVERSED', 'FAILED_CLOSED'
    ));

ALTER TABLE core.ledger_journals
    DROP CONSTRAINT ledger_journals_event_type_check,
    DROP CONSTRAINT ledger_journals_reversal_check;

ALTER TABLE core.ledger_journals
    ADD CONSTRAINT ledger_journals_event_type_check CHECK (event_type IN (
        'PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL',
        'ARBITRATION_DISPUTED', 'ARBITRATION_RESOLVED', 'FULFILLMENT_AVAILABLE',
        'SETTLEMENT_REQUESTED', 'SETTLEMENT_SUBMITTED', 'SETTLEMENT_SETTLED',
        'SETTLEMENT_EXECUTION_REVERSED', 'SETTLEMENT_FINALITY_REVERSED',
        'SETTLEMENT_FAILED_CLOSED',
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

CREATE OR REPLACE FUNCTION core.protect_settlement_transfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ImmutableSettlementTransfer' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
        OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version
        OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
        OR NEW.request_id IS DISTINCT FROM OLD.request_id
        OR NEW.request_item_index IS DISTINCT FROM OLD.request_item_index
        OR NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.asset IS DISTINCT FROM OLD.asset
        OR NEW.token_address IS DISTINCT FROM OLD.token_address
        OR NEW.executor_wallet IS DISTINCT FROM OLD.executor_wallet
        OR NEW.executor_nonce IS DISTINCT FROM OLD.executor_nonce
        OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.transfer_calldata IS DISTINCT FROM OLD.transfer_calldata
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.gas_cap IS DISTINCT FROM OLD.gas_cap
        OR NEW.token_code_hash IS DISTINCT FROM OLD.token_code_hash
        OR NEW.token_transfer_conformance_evidence_hash IS DISTINCT FROM OLD.token_transfer_conformance_evidence_hash
        OR NEW.runtime_evidence_hash IS DISTINCT FROM OLD.runtime_evidence_hash
        OR NEW.runtime_checked_at IS DISTINCT FROM OLD.runtime_checked_at
        OR NEW.authorization_mode IS DISTINCT FROM OLD.authorization_mode
        OR NEW.authorization_expires_at IS DISTINCT FROM OLD.authorization_expires_at
        OR NEW.authorization_evidence_hash IS DISTINCT FROM OLD.authorization_evidence_hash
        OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'ImmutableSettlementTransfer' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'PENDING' AND NEW.state IN ('LEASED', 'QUARANTINED'))
        OR (OLD.state = 'LEASED' AND NEW.state IN ('SUBMITTED', 'RETRYABLE', 'QUARANTINED'))
        OR (OLD.state = 'RETRYABLE' AND NEW.state IN ('LEASED', 'QUARANTINED'))
        OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('MINED', 'SETTLED', 'RETRYABLE', 'QUARANTINED'))
        OR (OLD.state = 'MINED' AND NEW.state IN ('SETTLED', 'RETRYABLE', 'QUARANTINED'))
        OR (OLD.state = 'SETTLED' AND NEW.state IN ('RETRYABLE', 'QUARANTINED'))
        OR (OLD.state = 'QUARANTINED' AND NEW.state = 'FAILED_CLOSED')
    ) THEN
        RAISE EXCEPTION 'InvalidSettlementTransferTransition' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
        AND NOT (OLD.submitted_at IS NULL AND NEW.submitted_at IS NOT NULL AND NEW.state = 'SUBMITTED')
    THEN
        RAISE EXCEPTION 'InvalidSettlementTransferTransition' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.settled_at IS DISTINCT FROM OLD.settled_at
        AND NOT (
            (OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL AND NEW.state = 'SETTLED')
            OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS NULL AND OLD.state = 'SETTLED' AND NEW.state = 'RETRYABLE')
        )
    THEN
        RAISE EXCEPTION 'InvalidSettlementTransferTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_settlement_transfer_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ImmutableSettlementTransferAttempt' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
        OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
        OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
        OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
        OR NEW.transaction_to IS DISTINCT FROM OLD.transaction_to
        OR NEW.transaction_calldata IS DISTINCT FROM OLD.transaction_calldata
        OR NEW.executor_wallet IS DISTINCT FROM OLD.executor_wallet
        OR NEW.executor_nonce IS DISTINCT FROM OLD.executor_nonce
        OR NEW.gas_limit IS DISTINCT FROM OLD.gas_limit
        OR NEW.replacement_for_attempt_id IS DISTINCT FROM OLD.replacement_for_attempt_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'ImmutableSettlementTransferAttempt' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'LEASED' AND NEW.state IN ('SUBMITTED', 'RETRYABLE', 'QUARANTINED'))
        OR (OLD.state = 'RETRYABLE' AND NEW.state IN ('LEASED', 'QUARANTINED'))
        OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('MINED', 'SETTLED', 'REPLACED', 'FAILED', 'REORGED', 'QUARANTINED'))
        OR (OLD.state = 'MINED' AND NEW.state IN ('SETTLED', 'REPLACED', 'FAILED', 'REORGED', 'QUARANTINED'))
        OR (OLD.state = 'SETTLED' AND NEW.state IN ('REORGED', 'QUARANTINED'))
        OR (OLD.state = 'QUARANTINED' AND NEW.state = 'FAILED_CLOSED')
    ) THEN
        RAISE EXCEPTION 'InvalidSettlementTransferAttemptTransition' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.leased_until IS DISTINCT FROM OLD.leased_until)
        AND NOT (OLD.state = 'RETRYABLE' AND NEW.state = 'LEASED')
    THEN
        RAISE EXCEPTION 'InvalidSettlementTransferAttemptTransition' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.execution_tx_hash IS DISTINCT FROM OLD.execution_tx_hash
        AND NOT (OLD.execution_tx_hash IS NULL AND NEW.execution_tx_hash IS NOT NULL AND NEW.state = 'SUBMITTED')
    THEN
        RAISE EXCEPTION 'InvalidSettlementTransferAttemptTransition' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
        AND NOT (OLD.submitted_at IS NULL AND NEW.submitted_at IS NOT NULL AND NEW.state = 'SUBMITTED')
    THEN
        RAISE EXCEPTION 'InvalidSettlementTransferAttemptTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
