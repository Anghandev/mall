-- D-V2-035 replaces every active Safe execution path with five distinct EOAs.
-- Legacy Safe tables remain append-only evidence and are never read by the EOA runtime.

ALTER TABLE core.ledger_accounts
    DROP CONSTRAINT ledger_accounts_owner_type_check,
    DROP CONSTRAINT ledger_accounts_purpose_check;

UPDATE core.ledger_accounts SET owner_type = 'WALLET' WHERE owner_type = 'SAFE';
UPDATE core.ledger_accounts SET purpose = 'WALLET_ASSET' WHERE purpose = 'SAFE_ASSET';

ALTER TABLE core.ledger_accounts
    ADD CONSTRAINT ledger_accounts_owner_type_check CHECK (owner_type IN (
        'SYSTEM', 'WALLET', 'MERCHANT', 'BUYER', 'BENEFICIARY', 'PLATFORM'
    )),
    ADD CONSTRAINT ledger_accounts_purpose_check CHECK (purpose IN (
        'WALLET_ASSET', 'PAYMENT_CLEARING', 'BURN', 'MERCHANT_RECEIVABLE',
        'MERCHANT_FREIGHT_RECEIVABLE', 'PLATFORM_SERVICE_FEE_REVENUE',
        'CONCESSION', 'POLICY_ALLOCATION', 'SECKILL_PRIZE_LIABILITY',
        'NODE_REWARD_POOL', 'REWARD_RESERVE_POOL',
        'REWARD_LIABILITY', 'BNM_ISSUANCE', 'BNM_LIABILITY',
        'GUARANTEE_ASSET', 'GUARANTEE_LIABILITY', 'MERCHANT_DEBT_RECEIVABLE',
        'TAKEOVER_PAYABLE', 'OPERATIONS_ADVANCE_ASSET',
        'OPERATIONS_REIMBURSEMENT', 'SETTLEMENT_CLEARING'
    ));
ALTER TABLE core.ledger_accounts DROP CONSTRAINT ledger_accounts_safe_address_check;
ALTER TABLE core.ledger_accounts RENAME COLUMN safe_address TO wallet_address;
ALTER TABLE core.ledger_accounts ADD CONSTRAINT ledger_accounts_wallet_address_check CHECK (
    wallet_address IS NULL OR wallet_address ~ '^0x[0-9a-fA-F]{40}$'
);

ALTER TABLE core.ledger_lines RENAME COLUMN backing_safe_address TO backing_wallet_address;
ALTER INDEX core.ledger_lines_backing_safe_idx RENAME TO ledger_lines_backing_wallet_idx;

ALTER TABLE core.ledger_lines DROP CONSTRAINT ledger_lines_balance_state_check;
UPDATE core.ledger_lines SET balance_state = 'SUBMITTED' WHERE balance_state = 'BATCHED';
ALTER TABLE core.ledger_lines
    ADD CONSTRAINT ledger_lines_balance_state_check CHECK (balance_state IN (
        'POSTED', 'LOCKED', 'AVAILABLE', 'REQUESTED', 'SUBMITTED', 'SETTLED', 'DISPUTED'
    ));

ALTER TABLE core.ledger_journals
    DROP CONSTRAINT ledger_journals_source_kind_check,
    DROP CONSTRAINT ledger_journals_chain_source_check,
    DROP CONSTRAINT ledger_journals_resource_type_check,
    DROP CONSTRAINT ledger_journals_event_type_check,
    DROP CONSTRAINT ledger_journals_reversal_check;
UPDATE core.ledger_journals SET source_kind = 'EOA_TRANSFER' WHERE source_kind = 'SAFE_BATCH';
UPDATE core.ledger_journals SET resource_type = 'SETTLEMENT_TRANSFER' WHERE resource_type = 'SETTLEMENT_BATCH';
UPDATE core.ledger_journals SET event_type = CASE event_type
    WHEN 'SETTLEMENT_BATCHED' THEN 'SETTLEMENT_SUBMITTED'
    WHEN 'SETTLEMENT_BATCH_REVERSED' THEN 'SETTLEMENT_EXECUTION_REVERSED'
    ELSE event_type
END;
ALTER TABLE core.ledger_journals
    ADD CONSTRAINT ledger_journals_resource_type_check CHECK (resource_type IN (
        'ORDER', 'SETTLEMENT_REQUEST', 'SETTLEMENT_TRANSFER', 'MERCHANT_GUARANTEE',
        'TAKEOVER_CASE', 'MERCHANT_DEBT', 'COVERAGE_SNAPSHOT', 'RECOVERY',
        'SECKILL_SESSION'
    )),
    ADD CONSTRAINT ledger_journals_event_type_check CHECK (event_type IN (
        'PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL',
        'ARBITRATION_DISPUTED', 'ARBITRATION_RESOLVED', 'FULFILLMENT_AVAILABLE',
        'SETTLEMENT_REQUESTED', 'SETTLEMENT_SUBMITTED', 'SETTLEMENT_SETTLED',
        'SETTLEMENT_EXECUTION_REVERSED', 'SETTLEMENT_FINALITY_REVERSED',
        'GUARANTEE_DEPOSITED', 'GUARANTEE_DEDUCTED',
        'TAKEOVER_FUNDED', 'MERCHANT_DEBT_CAPTURED', 'FUTURE_PROCEEDS_CAPTURED',
        'COVERAGE_RECONCILED', 'SECKILL_PRIZE_INJECTED',
        'SECKILL_PRIZE_INJECTION_REVERSED', 'SECKILL_PRIZE_AWARDED',
        'SECKILL_PRIZE_ROLLED_OVER'
    )),
    ADD CONSTRAINT ledger_journals_reversal_check CHECK (
        (event_type IN ('PAYMENT_REORG_REVERSAL', 'SECKILL_PRIZE_INJECTION_REVERSED'))
            = (reversal_of IS NOT NULL)
    ),
    ADD CONSTRAINT ledger_journals_source_kind_check CHECK (source_kind IN (
        'CHAIN_EVENT', 'SIGNED_REQUEST', 'EOA_TRANSFER', 'FULFILLMENT_EVIDENCE',
        'GOVERNED_EVIDENCE', 'RECONCILIATION'
    )),
    ADD CONSTRAINT ledger_journals_chain_source_check CHECK (
        (source_kind = 'CHAIN_EVENT'
            AND source_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
            AND source_block_hash ~ '^0x[0-9a-fA-F]{64}$')
        OR (source_kind = 'EOA_TRANSFER'
            AND source_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
            AND (source_block_hash IS NULL OR source_block_hash ~ '^0x[0-9a-fA-F]{64}$'))
        OR (source_kind NOT IN ('CHAIN_EVENT', 'EOA_TRANSFER')
            AND source_tx_hash IS NULL
            AND source_block_hash IS NULL)
    );

ALTER TABLE core.settlement_intents RENAME COLUMN safe_address TO executor_wallet;
ALTER TABLE core.settlement_intent_items RENAME COLUMN backing_safe_address TO backing_wallet_address;
ALTER TABLE core.settlement_requests RENAME COLUMN safe_address TO executor_wallet;
ALTER TABLE core.settlement_request_items RENAME COLUMN backing_safe_address TO backing_wallet_address;
ALTER TABLE core.settlement_request_items RENAME COLUMN batched_journal_id TO submitted_journal_id;
ALTER TABLE core.coverage_snapshot_items RENAME COLUMN safe_address TO wallet_address;
ALTER TABLE core.merchant_guarantees RENAME COLUMN backing_safe_address TO backing_wallet_address;
ALTER TABLE core.merchant_guarantee_deposit_submissions
    RENAME COLUMN operations_safe_address TO operations_wallet_address;
ALTER TABLE core.merchant_debt_recoveries RENAME COLUMN operations_safe_address TO operations_wallet_address;
ALTER TABLE core.merchant_debt_recoveries RENAME COLUMN backing_safe_address TO backing_wallet_address;
ALTER TABLE core.takeover_cases RENAME COLUMN platform_advance_safe_address TO platform_advance_wallet_address;
ALTER TABLE core.takeover_funding_commands RENAME COLUMN governance_safe_address TO governance_wallet_address;
ALTER TABLE core.takeover_funding_commands RENAME COLUMN safe_tx_hash TO approval_signature_hash;
ALTER TABLE core.takeover_funding_commands
    RENAME COLUMN safe_approval_evidence_hash TO approval_evidence_hash;
ALTER TABLE core.takeover_funding_commands DROP COLUMN safe_owner_approvals;
ALTER TABLE core.system_config_publication_events
    RENAME COLUMN safe_address TO governance_wallet_address;
ALTER TABLE core.system_config_publication_events
    RENAME COLUMN safe_tx_hash TO approval_signature_hash;
ALTER TABLE core.merchant_review_actions
    RENAME COLUMN governance_safe_address TO governance_wallet_address;
ALTER TABLE core.merchant_review_actions
    RENAME COLUMN safe_tx_hash TO approval_signature_hash;

DROP TRIGGER coverage_breaker_actions_protected ON core.coverage_breaker_actions;
DROP FUNCTION core.protect_coverage_breaker_action();
DROP INDEX core.coverage_breaker_one_open_target_idx;
DROP INDEX core.coverage_breaker_safe_nonce_idx;
ALTER TABLE core.coverage_breaker_actions
    DROP CONSTRAINT coverage_breaker_actions_state_check,
    DROP CONSTRAINT coverage_breaker_actions_check1,
    DROP CONSTRAINT coverage_breaker_safe_nonce_state,
    DROP CONSTRAINT coverage_breaker_actions_governance_safe_address_check,
    DROP CONSTRAINT coverage_breaker_actions_safe_nonce_check,
    DROP CONSTRAINT coverage_breaker_actions_safe_tx_hash_check,
    DROP CONSTRAINT coverage_breaker_actions_proposal_hash_check;
ALTER TABLE core.coverage_breaker_actions
    RENAME COLUMN governance_safe_address TO governance_wallet_address;
ALTER TABLE core.coverage_breaker_actions RENAME COLUMN safe_nonce TO executor_nonce;
ALTER TABLE core.coverage_breaker_actions RENAME COLUMN safe_tx_hash TO submitted_tx_hash;
ALTER TABLE core.coverage_breaker_actions RENAME COLUMN proposal_hash TO execution_evidence_hash;
UPDATE core.coverage_breaker_actions SET state = CASE state
    WHEN 'PENDING_PROPOSAL' THEN 'PENDING_EXECUTION'
    WHEN 'SAFE_PROPOSED' THEN 'SUBMITTED'
    ELSE state
END;
ALTER TABLE core.coverage_breaker_actions
    ADD CONSTRAINT coverage_breaker_actions_governance_wallet_check CHECK (
        governance_wallet_address ~ '^0x[0-9a-f]{40}$'
    ),
    ADD CONSTRAINT coverage_breaker_actions_executor_nonce_check CHECK (
        executor_nonce IS NULL OR (
            executor_nonce >= 0
            AND executor_nonce < 115792089237316195423570985008687907853269984665640564039457584007913129639936
        )
    ),
    ADD CONSTRAINT coverage_breaker_actions_submitted_tx_hash_check CHECK (
        submitted_tx_hash IS NULL OR submitted_tx_hash ~ '^0x[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT coverage_breaker_actions_execution_evidence_hash_check CHECK (
        execution_evidence_hash IS NULL OR execution_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT coverage_breaker_actions_state_eoa_check CHECK (state IN (
        'PENDING_EXECUTION', 'SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'FAILED', 'SUPERSEDED'
    )),
    ADD CONSTRAINT coverage_breaker_actions_execution_state_check CHECK (
        (state IN ('PENDING_EXECUTION', 'SUPERSEDED')
            AND executor_nonce IS NULL
            AND submitted_tx_hash IS NULL
            AND execution_evidence_hash IS NULL)
        OR (state NOT IN ('PENDING_EXECUTION', 'SUPERSEDED')
            AND executor_nonce IS NOT NULL
            AND submitted_tx_hash IS NOT NULL
            AND execution_evidence_hash IS NOT NULL)
    );
CREATE UNIQUE INDEX coverage_breaker_one_open_target_idx
    ON core.coverage_breaker_actions (target_paused)
    WHERE state IN ('PENDING_EXECUTION', 'SUBMITTED', 'MINED');
CREATE UNIQUE INDEX coverage_breaker_executor_nonce_idx
    ON core.coverage_breaker_actions (governance_wallet_address, executor_nonce)
    WHERE executor_nonce IS NOT NULL;

ALTER TABLE core.coverage_breaker_action_transitions
    DROP CONSTRAINT coverage_breaker_action_transitions_from_state_check,
    DROP CONSTRAINT coverage_breaker_action_transitions_to_state_check;
UPDATE core.coverage_breaker_action_transitions SET from_state = CASE from_state
    WHEN 'PENDING_PROPOSAL' THEN 'PENDING_EXECUTION'
    WHEN 'SAFE_PROPOSED' THEN 'SUBMITTED'
    ELSE from_state
END;
UPDATE core.coverage_breaker_action_transitions SET to_state = CASE to_state
    WHEN 'PENDING_PROPOSAL' THEN 'PENDING_EXECUTION'
    WHEN 'SAFE_PROPOSED' THEN 'SUBMITTED'
    ELSE to_state
END;
ALTER TABLE core.coverage_breaker_action_transitions
    ADD CONSTRAINT coverage_breaker_action_transitions_from_state_eoa_check CHECK (
        from_state IS NULL OR from_state IN (
            'PENDING_EXECUTION', 'SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'FAILED', 'SUPERSEDED'
        )
    ),
    ADD CONSTRAINT coverage_breaker_action_transitions_to_state_eoa_check CHECK (to_state IN (
        'PENDING_EXECUTION', 'SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'FAILED', 'SUPERSEDED'
    ));

CREATE FUNCTION core.protect_coverage_breaker_action() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.action_id IS DISTINCT FROM OLD.action_id
       OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
       OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
       OR NEW.action IS DISTINCT FROM OLD.action
       OR NEW.target_paused IS DISTINCT FROM OLD.target_paused
       OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
       OR NEW.governance_wallet_address IS DISTINCT FROM OLD.governance_wallet_address
       OR NEW.router_address IS DISTINCT FROM OLD.router_address
       OR NEW.calldata IS DISTINCT FROM OLD.calldata
       OR NEW.calldata_hash IS DISTINCT FROM OLD.calldata_hash
       OR NEW.replaces_action_id IS DISTINCT FROM OLD.replaces_action_id
       OR NEW.actor_wallet IS DISTINCT FROM OLD.actor_wallet
       OR NEW.secondary_signer IS DISTINCT FROM OLD.secondary_signer
       OR NEW.secondary_signature_hash IS DISTINCT FROM OLD.secondary_signature_hash
       OR NEW.approval_nonce IS DISTINCT FROM OLD.approval_nonce
       OR NEW.approval_deadline IS DISTINCT FROM OLD.approval_deadline
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (
           NEW.executor_nonce IS DISTINCT FROM OLD.executor_nonce
           AND NOT (
               OLD.state = 'PENDING_EXECUTION'
               AND OLD.executor_nonce IS NULL
               AND NEW.state = 'SUBMITTED'
               AND NEW.executor_nonce IS NOT NULL
           )
       ) THEN
        RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER coverage_breaker_actions_protected
    BEFORE UPDATE ON core.coverage_breaker_actions
    FOR EACH ROW EXECUTE FUNCTION core.protect_coverage_breaker_action();

DROP INDEX core.seckill_governance_actions_pending_idx;
ALTER TABLE core.seckill_governance_actions
    DROP CONSTRAINT seckill_governance_actions_state_check,
    DROP CONSTRAINT seckill_governance_actions_governance_safe_address_check,
    DROP CONSTRAINT seckill_governance_actions_safe_nonce_check,
    DROP CONSTRAINT seckill_governance_actions_safe_tx_hash_check,
    DROP CONSTRAINT seckill_governance_actions_proposal_hash_check;
ALTER TABLE core.seckill_governance_actions
    RENAME COLUMN governance_safe_address TO governance_wallet_address;
ALTER TABLE core.seckill_governance_actions RENAME COLUMN safe_nonce TO executor_nonce;
ALTER TABLE core.seckill_governance_actions RENAME COLUMN safe_tx_hash TO submitted_tx_hash;
ALTER TABLE core.seckill_governance_actions RENAME COLUMN proposal_hash TO execution_evidence_hash;
UPDATE core.seckill_governance_actions SET state = CASE state
    WHEN 'PENDING_PROPOSAL' THEN 'PENDING_EXECUTION'
    WHEN 'SAFE_PROPOSED' THEN 'SUBMITTED'
    ELSE state
END;
ALTER TABLE core.seckill_governance_actions
    ADD CONSTRAINT seckill_governance_actions_governance_wallet_check CHECK (
        governance_wallet_address ~ '^0x[0-9a-f]{40}$'
    ),
    ADD CONSTRAINT seckill_governance_actions_executor_nonce_check CHECK (
        executor_nonce IS NULL OR executor_nonce >= 0
    ),
    ADD CONSTRAINT seckill_governance_actions_submitted_tx_hash_check CHECK (
        submitted_tx_hash IS NULL OR submitted_tx_hash ~ '^0x[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT seckill_governance_actions_execution_evidence_hash_check CHECK (
        execution_evidence_hash IS NULL OR execution_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT seckill_governance_actions_state_eoa_check CHECK (state IN (
        'DRAFT', 'SECONDARY_SIGNED', 'PENDING_EXECUTION', 'SUBMITTED',
        'MINED', 'FINAL', 'REORGED', 'FAILED', 'CANCELLED'
    )),
    ADD CONSTRAINT seckill_governance_actions_execution_state_check CHECK (
        (state IN ('DRAFT', 'SECONDARY_SIGNED', 'PENDING_EXECUTION', 'CANCELLED')
            AND executor_nonce IS NULL
            AND submitted_tx_hash IS NULL
            AND execution_evidence_hash IS NULL)
        OR (state IN ('SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'FAILED')
            AND executor_nonce IS NOT NULL
            AND submitted_tx_hash IS NOT NULL
            AND execution_evidence_hash IS NOT NULL)
    );
CREATE INDEX seckill_governance_actions_pending_idx
    ON core.seckill_governance_actions (state, updated_at, action_id)
    WHERE state IN ('PENDING_EXECUTION', 'SUBMITTED', 'MINED', 'FINAL');
CREATE UNIQUE INDEX seckill_governance_actions_executor_nonce_idx
    ON core.seckill_governance_actions (governance_wallet_address, executor_nonce)
    WHERE executor_nonce IS NOT NULL;
UPDATE core.seckill_governance_transitions SET from_state = CASE from_state
    WHEN 'PENDING_PROPOSAL' THEN 'PENDING_EXECUTION'
    WHEN 'SAFE_PROPOSED' THEN 'SUBMITTED'
    ELSE from_state
END;
UPDATE core.seckill_governance_transitions SET to_state = CASE to_state
    WHEN 'PENDING_PROPOSAL' THEN 'PENDING_EXECUTION'
    WHEN 'SAFE_PROPOSED' THEN 'SUBMITTED'
    ELSE to_state
END;
ALTER TABLE core.seckill_prize_injections
    RENAME COLUMN operations_safe_address TO operations_wallet_address;
ALTER TABLE core.seckill_prize_injections
    RENAME COLUMN custody_safe_address TO settlement_wallet_address;

DROP TRIGGER policy_drafts_protected ON core.policy_drafts;
DROP FUNCTION core.protect_policy_draft();
ALTER TABLE core.policy_drafts
    DROP CONSTRAINT policy_drafts_state_check,
    DROP CONSTRAINT policy_drafts_publication_evidence_check,
    DROP CONSTRAINT policy_drafts_safe_proposal_check;
ALTER TABLE core.policy_drafts RENAME COLUMN safe_address TO governance_wallet_address;
ALTER TABLE core.policy_drafts RENAME COLUMN safe_calldata TO execution_calldata;
ALTER TABLE core.policy_drafts RENAME COLUMN safe_calldata_hash TO execution_calldata_hash;
ALTER TABLE core.policy_drafts RENAME COLUMN safe_tx_hash TO execution_tx_hash;
ALTER TABLE core.policy_drafts RENAME COLUMN safe_proposal_hash TO execution_evidence_hash;
UPDATE core.policy_drafts SET state = 'SUBMITTED' WHERE state = 'SAFE_PROPOSED';
ALTER TABLE core.policy_drafts
    ADD CONSTRAINT policy_drafts_state_check CHECK (state IN (
        'DRAFT', 'DECISION_BLOCKED', 'SECONDARY_SIGNED', 'SUBMITTED',
        'FINALITY_PENDING', 'REORGED', 'REJECTED', 'PUBLISHED'
    )),
    ADD CONSTRAINT policy_drafts_publication_evidence_check CHECK (
        state IN ('DRAFT', 'DECISION_BLOCKED', 'REJECTED')
        OR (
            artifact_version IS NOT NULL AND request_hash IS NOT NULL
            AND policy_hash IS NOT NULL AND operations_hash IS NOT NULL
            AND publication_digest IS NOT NULL AND publication_nonce IS NOT NULL
            AND publication_deadline IS NOT NULL AND secondary_signer IS NOT NULL
            AND secondary_signature IS NOT NULL AND secondary_signature_hash IS NOT NULL
            AND governance_wallet_address IS NOT NULL AND execution_calldata IS NOT NULL
            AND execution_calldata_hash IS NOT NULL
        )
    ),
    ADD CONSTRAINT policy_drafts_execution_check CHECK (
        state NOT IN ('SUBMITTED', 'FINALITY_PENDING', 'REORGED', 'PUBLISHED')
        OR (execution_tx_hash IS NOT NULL AND execution_evidence_hash IS NOT NULL)
    );

ALTER TABLE core.policy_draft_transitions
    DROP CONSTRAINT policy_draft_transitions_to_state_check;
UPDATE core.policy_draft_transitions SET to_state = 'SUBMITTED' WHERE to_state = 'SAFE_PROPOSED';
UPDATE core.policy_draft_transitions SET from_state = 'SUBMITTED' WHERE from_state = 'SAFE_PROPOSED';
ALTER TABLE core.policy_draft_transitions
    ADD CONSTRAINT policy_draft_transitions_to_state_check CHECK (to_state IN (
        'DRAFT', 'DECISION_BLOCKED', 'SECONDARY_SIGNED', 'SUBMITTED',
        'FINALITY_PENDING', 'REORGED', 'REJECTED', 'PUBLISHED'
    ));

ALTER TABLE core.policy_snapshots RENAME COLUMN safe_tx_hash TO publication_tx_hash;
ALTER TABLE core.policy_publication_transitions
    RENAME COLUMN safe_tx_hash TO submitted_execution_tx_hash;

CREATE FUNCTION core.protect_policy_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state IN ('SECONDARY_SIGNED', 'SUBMITTED', 'FINALITY_PENDING', 'REORGED', 'PUBLISHED')
       AND (
           NEW.next_policy_version IS DISTINCT FROM OLD.next_policy_version
           OR NEW.base_policy_version IS DISTINCT FROM OLD.base_policy_version
           OR NEW.payload IS DISTINCT FROM OLD.payload
           OR NEW.validation_errors IS DISTINCT FROM OLD.validation_errors
           OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
           OR NEW.operations_hash IS DISTINCT FROM OLD.operations_hash
           OR NEW.publication_digest IS DISTINCT FROM OLD.publication_digest
           OR NEW.publication_nonce IS DISTINCT FROM OLD.publication_nonce
           OR NEW.publication_deadline IS DISTINCT FROM OLD.publication_deadline
           OR NEW.secondary_signer IS DISTINCT FROM OLD.secondary_signer
           OR NEW.secondary_signature IS DISTINCT FROM OLD.secondary_signature
           OR NEW.secondary_signature_hash IS DISTINCT FROM OLD.secondary_signature_hash
           OR NEW.governance_wallet_address IS DISTINCT FROM OLD.governance_wallet_address
           OR NEW.execution_calldata IS DISTINCT FROM OLD.execution_calldata
           OR NEW.execution_calldata_hash IS DISTINCT FROM OLD.execution_calldata_hash
       )
    THEN
        RAISE EXCEPTION 'ImmutablePolicyApproval' USING ERRCODE = 'P0001';
    END IF;
    IF NOT (
        (OLD.state IN ('DRAFT', 'DECISION_BLOCKED') AND NEW.state IN ('DRAFT', 'DECISION_BLOCKED', 'SECONDARY_SIGNED', 'REJECTED'))
        OR (OLD.state = 'SECONDARY_SIGNED' AND NEW.state IN ('SUBMITTED', 'REJECTED'))
        OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('FINALITY_PENDING', 'REORGED', 'REJECTED'))
        OR (OLD.state = 'FINALITY_PENDING' AND NEW.state IN ('PUBLISHED', 'REORGED'))
        OR (OLD.state = 'REORGED' AND NEW.state IN ('SUBMITTED', 'FINALITY_PENDING', 'PUBLISHED', 'REJECTED'))
        OR (OLD.state = 'PUBLISHED' AND NEW.state = 'REORGED')
        OR OLD.state = NEW.state
    ) THEN
        RAISE EXCEPTION 'InvalidPolicyDraftTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER policy_drafts_protected
    BEFORE UPDATE ON core.policy_drafts
    FOR EACH ROW EXECUTE FUNCTION core.protect_policy_draft();

ALTER TABLE core.settlement_requests
    DROP CONSTRAINT IF EXISTS settlement_requests_batch_fk,
    DROP CONSTRAINT settlement_requests_state_check,
    DROP CONSTRAINT settlement_requests_batch_state_check,
    DROP CONSTRAINT settlement_requests_safe_tx_check,
    DROP CONSTRAINT settlement_requests_execution_tx_check;

UPDATE core.settlement_requests
SET state = 'QUARANTINED'
WHERE state IN ('BATCHED', 'RETRYABLE');

ALTER TABLE core.settlement_requests
    RENAME COLUMN batch_id TO legacy_safe_batch_id;
ALTER TABLE core.settlement_requests
    RENAME COLUMN final_safe_tx_hash TO legacy_final_safe_tx_hash;
ALTER TABLE core.settlement_requests
    RENAME COLUMN final_execution_tx_hash TO legacy_final_execution_tx_hash;
ALTER TABLE core.settlement_requests
    RENAME COLUMN batched_at TO submitted_at;

ALTER TABLE core.settlement_requests
    ADD CONSTRAINT settlement_requests_state_eoa_check CHECK (
        state IN ('REQUESTED', 'SUBMITTED', 'SETTLED', 'RETRYABLE', 'QUARANTINED')
    ),
    ADD CONSTRAINT settlement_requests_submitted_at_check CHECK (
        state NOT IN ('SUBMITTED', 'SETTLED') OR submitted_at IS NOT NULL
    );

ALTER INDEX core.settlement_requests_batch_idx RENAME TO settlement_requests_legacy_safe_batch_idx;

ALTER TABLE core.settlement_request_item_transitions
    DROP CONSTRAINT IF EXISTS settlement_request_item_transitions_batch_fk,
    DROP CONSTRAINT settlement_request_item_transitions_transition_type_check;
UPDATE core.settlement_request_item_transitions
SET transition_type = CASE transition_type
    WHEN 'BATCHED' THEN 'SUBMITTED'
    WHEN 'BATCH_REVERSED' THEN 'EXECUTION_REVERSED'
    ELSE transition_type
END;
ALTER TABLE core.settlement_request_item_transitions RENAME COLUMN batch_id TO transfer_id;
UPDATE core.settlement_request_item_transitions SET transfer_id = NULL;
ALTER TABLE core.settlement_request_item_transitions
    ADD CONSTRAINT settlement_request_item_transitions_type_check CHECK (transition_type IN (
        'REQUESTED', 'SUBMITTED', 'SETTLED', 'EXECUTION_REVERSED', 'FINALITY_REVERSED'
    ));

ALTER TABLE core.settlement_payment_reorg_exposures
    DROP CONSTRAINT IF EXISTS settlement_payment_reorg_exposures_batch_id_fkey;
UPDATE core.settlement_payment_reorg_exposures SET batch_id = NULL;
ALTER TABLE core.settlement_payment_reorg_exposures RENAME COLUMN batch_id TO transfer_id;
ALTER TABLE core.settlement_payment_reorg_exposures RENAME COLUMN previous_batch_state TO previous_transfer_state;
ALTER TABLE core.settlement_payment_reorg_exposures RENAME COLUMN final_safe_tx_hash TO legacy_final_safe_tx_hash;

ALTER TABLE core.safe_nonce_reservations RENAME TO legacy_safe_nonce_reservations;
ALTER TABLE core.settlement_batches RENAME TO legacy_safe_settlement_batches;
ALTER TABLE core.settlement_batch_items RENAME TO legacy_safe_settlement_batch_items;
ALTER TABLE core.settlement_batch_approvals RENAME TO legacy_safe_settlement_batch_approvals;
ALTER TABLE core.settlement_execution_attempts RENAME TO legacy_safe_settlement_execution_attempts;

CREATE TABLE core.settlement_transfers (
    transfer_id text PRIMARY KEY CHECK (transfer_id ~ '^0x[0-9a-f]{64}$'),
    artifact_version text NOT NULL,
    chain_id bigint NOT NULL CHECK (chain_id = 56),
    request_id text NOT NULL,
    request_item_index integer NOT NULL,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    account_id text NOT NULL REFERENCES core.ledger_accounts(account_id),
    asset text NOT NULL CHECK (asset IN ('USDT', 'NPL')),
    token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
    executor_wallet text NOT NULL CHECK (executor_wallet ~ '^0x[0-9a-f]{40}$'),
    executor_nonce numeric(78, 0) NOT NULL CHECK (executor_nonce >= 0),
    recipient_address text NOT NULL CHECK (
        recipient_address ~ '^0x[0-9a-f]{40}$'
        AND recipient_address <> '0x0000000000000000000000000000000000000000'
    ),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    transfer_calldata text NOT NULL CHECK (transfer_calldata ~ '^0x(?:[0-9a-fA-F]{2})+$'),
    content_hash text NOT NULL UNIQUE CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
    idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    gas_cap numeric(78, 0) NOT NULL CHECK (gas_cap > 0),
    token_code_hash text NOT NULL CHECK (token_code_hash ~ '^0x[0-9a-f]{64}$'),
    token_transfer_conformance_evidence_hash text NOT NULL
        CHECK (token_transfer_conformance_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    runtime_evidence_hash text NOT NULL CHECK (runtime_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    runtime_checked_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN (
        'PENDING', 'LEASED', 'SUBMITTED', 'MINED', 'SETTLED',
        'FAILED', 'RETRYABLE', 'REORGED', 'QUARANTINED'
    )),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    submitted_at timestamptz,
    settled_at timestamptz,
    FOREIGN KEY (request_id, request_item_index)
        REFERENCES core.settlement_request_items(request_id, item_index),
    UNIQUE (request_id, request_item_index),
    UNIQUE (executor_wallet, executor_nonce),
    CHECK (state <> 'SETTLED' OR settled_at IS NOT NULL)
);

CREATE INDEX settlement_transfers_state_idx
    ON core.settlement_transfers (state, created_at, transfer_id);

CREATE TABLE core.settlement_transfer_attempts (
    attempt_id text PRIMARY KEY,
    transfer_id text NOT NULL REFERENCES core.settlement_transfers(transfer_id),
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    lease_token text NOT NULL UNIQUE,
    request_digest text NOT NULL CHECK (request_digest ~ '^0x[0-9a-f]{64}$'),
    transaction_to text NOT NULL CHECK (transaction_to ~ '^0x[0-9a-f]{40}$'),
    transaction_calldata text NOT NULL CHECK (transaction_calldata ~ '^0x(?:[0-9a-fA-F]{2})+$'),
    execution_tx_hash text UNIQUE CHECK (
        execution_tx_hash IS NULL OR execution_tx_hash ~ '^0x[0-9a-f]{64}$'
    ),
    executor_wallet text NOT NULL CHECK (executor_wallet ~ '^0x[0-9a-f]{40}$'),
    executor_nonce numeric(78, 0) NOT NULL CHECK (executor_nonce >= 0),
    gas_limit numeric(78, 0) NOT NULL CHECK (gas_limit > 0),
    replacement_for_attempt_id text REFERENCES core.settlement_transfer_attempts(attempt_id),
    state text NOT NULL CHECK (state IN (
        'LEASED', 'SUBMITTED', 'MINED', 'SETTLED', 'REPLACED',
        'FAILED', 'REORGED', 'QUARANTINED'
    )),
    leased_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    submitted_at timestamptz,
    updated_at timestamptz NOT NULL,
    UNIQUE (transfer_id, attempt_number),
    UNIQUE (replacement_for_attempt_id),
    UNIQUE (executor_wallet, executor_nonce, execution_tx_hash)
);

ALTER TABLE core.settlement_request_item_transitions
    ADD CONSTRAINT settlement_request_item_transitions_transfer_fk
    FOREIGN KEY (transfer_id) REFERENCES core.settlement_transfers(transfer_id);

ALTER TABLE core.settlement_payment_reorg_exposures
    ADD CONSTRAINT settlement_payment_reorg_exposures_transfer_fk
    FOREIGN KEY (transfer_id) REFERENCES core.settlement_transfers(transfer_id);

ALTER TABLE core.transaction_finality
    DROP CONSTRAINT transaction_finality_resource_type_check;
ALTER TABLE core.transaction_finality
    ADD CONSTRAINT transaction_finality_resource_type_check CHECK (resource_type IN (
        'ORDER_PAYMENT', 'FULFILLMENT', 'SETTLEMENT_BATCH', 'SETTLEMENT_TRANSFER',
        'SECKILL_SETTLEMENT', 'POLICY', 'TAKEOVER_DISBURSEMENT', 'RECOVERY'
    ));

CREATE OR REPLACE FUNCTION core.post_resource_balanced_journal(
    p_journal_id text,
    p_event_key text,
    p_event_type text,
    p_resource_type text,
    p_resource_id text,
    p_order_id text,
    p_policy_version bigint,
    p_content_hash text,
    p_source_tx_hash text,
    p_source_block_hash text,
    p_source_kind text,
    p_source_reference_hash text,
    p_reversal_of text,
    p_payload jsonb,
    p_lines jsonb
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    existing core.ledger_journals;
BEGIN
    SELECT * INTO existing FROM core.ledger_journals WHERE event_key = p_event_key;
    IF FOUND THEN
        IF existing.content_hash <> p_content_hash
            OR existing.resource_type <> p_resource_type
            OR existing.resource_id <> p_resource_id
        THEN
            RAISE EXCEPTION 'LedgerIdempotencyConflict' USING ERRCODE = 'P0001';
        END IF;
        RETURN existing.journal_id;
    END IF;

    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
        RAISE EXCEPTION 'InvalidLedgerLines' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_lines) AS line(
            account_id text, side text, amount numeric, balance_state text, backing_wallet_address text
        )
        LEFT JOIN core.ledger_accounts account ON account.account_id = line.account_id
        WHERE account.account_id IS NULL OR line.side NOT IN ('DEBIT', 'CREDIT') OR line.amount <= 0
            OR line.balance_state NOT IN (
                'POSTED', 'LOCKED', 'AVAILABLE', 'REQUESTED', 'SUBMITTED', 'SETTLED', 'DISPUTED'
            )
            OR (
                line.backing_wallet_address IS NOT NULL
                AND line.backing_wallet_address !~ '^0x[0-9a-fA-F]{40}$'
            )
    ) THEN
        RAISE EXCEPTION 'InvalidLedgerLines' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_lines) AS line(
            account_id text, side text, amount numeric, balance_state text, backing_wallet_address text
        )
        JOIN core.ledger_accounts account ON account.account_id = line.account_id
        GROUP BY account.asset
        HAVING sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE 0 END)
            <> sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE 0 END)
    ) THEN
        RAISE EXCEPTION 'UnbalancedLedgerJournal' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO core.ledger_journals (
        journal_id, event_key, event_type, resource_type, resource_id, order_id,
        policy_version, content_hash, source_tx_hash, source_block_hash,
        source_kind, source_reference_hash, reversal_of, payload
    ) VALUES (
        p_journal_id, p_event_key, p_event_type, p_resource_type, p_resource_id, p_order_id,
        p_policy_version, p_content_hash, p_source_tx_hash, p_source_block_hash,
        p_source_kind, p_source_reference_hash, p_reversal_of, p_payload
    );
    INSERT INTO core.ledger_lines (
        journal_id, account_id, side, amount, balance_state, backing_wallet_address
    )
    SELECT p_journal_id, line.account_id, line.side, line.amount, line.balance_state,
        lower(line.backing_wallet_address)
    FROM jsonb_to_recordset(p_lines) AS line(
        account_id text, side text, amount numeric, balance_state text, backing_wallet_address text
    );
    RETURN p_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_settlement_intent_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
        OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version
        OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
        OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
        OR NEW.rail IS DISTINCT FROM OLD.rail
        OR NEW.asset IS DISTINCT FROM OLD.asset
        OR NEW.asset_address IS DISTINCT FROM OLD.asset_address
        OR NEW.executor_wallet IS DISTINCT FROM OLD.executor_wallet
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.items_hash IS DISTINCT FROM OLD.items_hash
        OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest
        OR NEW.nonce IS DISTINCT FROM OLD.nonce
        OR NEW.deadline IS DISTINCT FROM OLD.deadline
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'ImmutableSettlementIntent' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        OLD.state = 'ISSUED' AND NEW.state IN ('CONSUMED', 'EXPIRED', 'CANCELLED')
    ) THEN
        RAISE EXCEPTION 'InvalidSettlementIntentTransition' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state IS NOT DISTINCT FROM OLD.state
        AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
    THEN
        RAISE EXCEPTION 'InvalidSettlementIntentTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_settlement_request_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.request_id IS DISTINCT FROM OLD.request_id
        OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
        OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version
        OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
        OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
        OR NEW.rail IS DISTINCT FROM OLD.rail
        OR NEW.asset IS DISTINCT FROM OLD.asset
        OR NEW.asset_address IS DISTINCT FROM OLD.asset_address
        OR NEW.executor_wallet IS DISTINCT FROM OLD.executor_wallet
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.items_hash IS DISTINCT FROM OLD.items_hash
        OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest
        OR NEW.signature IS DISTINCT FROM OLD.signature
        OR NEW.signature_hash IS DISTINCT FROM OLD.signature_hash
        OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    THEN
        RAISE EXCEPTION 'ImmutableSettlementRequest' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_settlement_request_item_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.request_id IS DISTINCT FROM OLD.request_id
        OR NEW.item_index IS DISTINCT FROM OLD.item_index
        OR NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.backing_wallet_address IS DISTINCT FROM OLD.backing_wallet_address
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.requested_journal_id IS DISTINCT FROM OLD.requested_journal_id
    THEN
        RAISE EXCEPTION 'ImmutableSettlementRequestItem' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_merchant_debt_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.recovery_id IS DISTINCT FROM OLD.recovery_id
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.case_id IS DISTINCT FROM OLD.case_id
        OR NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.amount_usdt IS DISTINCT FROM OLD.amount_usdt
        OR NEW.operations_wallet_address IS DISTINCT FROM OLD.operations_wallet_address
        OR NEW.backing_wallet_address IS DISTINCT FROM OLD.backing_wallet_address
        OR NEW.journal_id IS DISTINCT FROM OLD.journal_id
        OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
        OR NEW.recovered_at IS DISTINCT FROM OLD.recovered_at
        OR (OLD.reversed_at IS NOT NULL AND (
            NEW.reversed_at IS DISTINCT FROM OLD.reversed_at
            OR NEW.reversal_evidence_hash IS DISTINCT FROM OLD.reversal_evidence_hash
        ))
    THEN
        RAISE EXCEPTION 'ImmutableMerchantDebtRecovery' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_takeover_funding_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.required_usdt IS NOT NULL AND (
        NEW.required_usdt IS DISTINCT FROM OLD.required_usdt
        OR NEW.guarantee_used_usdt IS DISTINCT FROM OLD.guarantee_used_usdt
        OR NEW.merchant_available_used_usdt IS DISTINCT FROM OLD.merchant_available_used_usdt
        OR NEW.future_proceeds_used_usdt IS DISTINCT FROM OLD.future_proceeds_used_usdt
        OR NEW.platform_advance_usdt IS DISTINCT FROM OLD.platform_advance_usdt
        OR NEW.platform_advance_wallet_address IS DISTINCT FROM OLD.platform_advance_wallet_address
        OR NEW.merchant_debt_usdt IS DISTINCT FROM OLD.merchant_debt_usdt
    ) THEN
        RAISE EXCEPTION 'ImmutableTakeoverFundingSnapshot' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_merchant_guarantee_deposit_submission() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deposit_id IS DISTINCT FROM OLD.deposit_id
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.merchant_wallet IS DISTINCT FROM OLD.merchant_wallet
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
        OR NEW.token_address IS DISTINCT FROM OLD.token_address
        OR NEW.operations_wallet_address IS DISTINCT FROM OLD.operations_wallet_address
        OR NEW.expected_amount_usdt IS DISTINCT FROM OLD.expected_amount_usdt
        OR NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
        OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
        OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (OLD.final_journal_id IS NOT NULL AND NEW.final_journal_id IS DISTINCT FROM OLD.final_journal_id)
        OR (OLD.final_journal_id IS NULL AND NEW.final_journal_id IS NOT NULL AND NEW.state <> 'FINAL')
    THEN
        RAISE EXCEPTION 'ImmutableGuaranteeDepositSubmission' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_merchant_review_action() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.action_id IS DISTINCT FROM OLD.action_id
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.action_kind IS DISTINCT FROM OLD.action_kind
        OR NEW.from_status IS DISTINCT FROM OLD.from_status
        OR NEW.to_status IS DISTINCT FROM OLD.to_status
        OR NEW.application_version IS DISTINCT FROM OLD.application_version
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
        OR NEW.old_value_hash IS DISTINCT FROM OLD.old_value_hash
        OR NEW.new_value_hash IS DISTINCT FROM OLD.new_value_hash
        OR NEW.approval_nonce IS DISTINCT FROM OLD.approval_nonce
        OR NEW.approval_deadline IS DISTINCT FROM OLD.approval_deadline
        OR NEW.governance_wallet_address IS DISTINCT FROM OLD.governance_wallet_address
        OR NEW.actor_wallet IS DISTINCT FROM OLD.actor_wallet
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR OLD.state <> 'DRAFT'
        OR NEW.state NOT IN ('PUBLISHED', 'EXPIRED')
    THEN
        RAISE EXCEPTION 'ImmutableMerchantReviewAction' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
