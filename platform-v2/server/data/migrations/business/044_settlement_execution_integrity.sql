CREATE FUNCTION core.protect_settlement_transfer() RETURNS trigger
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

CREATE TRIGGER settlement_transfers_integrity
    BEFORE UPDATE OR DELETE ON core.settlement_transfers
    FOR EACH ROW EXECUTE FUNCTION core.protect_settlement_transfer();

CREATE FUNCTION core.protect_settlement_transfer_attempt() RETURNS trigger
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

CREATE TRIGGER settlement_transfer_attempts_integrity
    BEFORE UPDATE OR DELETE ON core.settlement_transfer_attempts
    FOR EACH ROW EXECUTE FUNCTION core.protect_settlement_transfer_attempt();
