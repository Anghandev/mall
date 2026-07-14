ALTER TABLE core.ledger_accounts
    DROP CONSTRAINT ledger_accounts_owner_type_check,
    DROP CONSTRAINT ledger_accounts_purpose_check;

ALTER TABLE core.ledger_accounts
    ADD CONSTRAINT ledger_accounts_owner_type_check CHECK (owner_type IN (
        'SYSTEM', 'SAFE', 'MERCHANT', 'BUYER', 'BENEFICIARY', 'PLATFORM'
    )),
    ADD CONSTRAINT ledger_accounts_purpose_check CHECK (purpose IN (
        'SAFE_ASSET', 'PAYMENT_CLEARING', 'BURN', 'MERCHANT_RECEIVABLE',
        'CONCESSION', 'POLICY_ALLOCATION', 'SECKILL_PRIZE_LIABILITY',
        'REWARD_LIABILITY', 'BNM_ISSUANCE', 'BNM_LIABILITY',
        'GUARANTEE_ASSET', 'GUARANTEE_LIABILITY', 'MERCHANT_DEBT_RECEIVABLE',
        'TAKEOVER_PAYABLE', 'OPERATIONS_ADVANCE_ASSET',
        'OPERATIONS_REIMBURSEMENT', 'SETTLEMENT_CLEARING'
    ));

ALTER TABLE core.ledger_lines
    ADD COLUMN backing_safe_address text
        CHECK (backing_safe_address IS NULL OR backing_safe_address ~ '^0x[0-9a-fA-F]{40}$');

CREATE INDEX ledger_lines_backing_safe_idx
    ON core.ledger_lines (backing_safe_address, balance_state, account_id)
    WHERE backing_safe_address IS NOT NULL;

ALTER TABLE core.ledger_journals
    DROP CONSTRAINT ledger_journals_event_type_check,
    ALTER COLUMN order_id DROP NOT NULL,
    ALTER COLUMN policy_version DROP NOT NULL,
    ALTER COLUMN source_tx_hash DROP NOT NULL,
    ALTER COLUMN source_block_hash DROP NOT NULL,
    ADD COLUMN resource_type text,
    ADD COLUMN resource_id text,
    ADD COLUMN source_kind text NOT NULL DEFAULT 'CHAIN_EVENT',
    ADD COLUMN source_reference_hash text;

UPDATE core.ledger_journals
SET resource_type = 'ORDER', resource_id = order_id,
    source_reference_hash = source_tx_hash
WHERE resource_type IS NULL;

ALTER TABLE core.ledger_journals
    ALTER COLUMN resource_type SET NOT NULL,
    ALTER COLUMN resource_id SET NOT NULL,
    ALTER COLUMN source_reference_hash SET NOT NULL,
    ADD CONSTRAINT ledger_journals_resource_type_check CHECK (resource_type IN (
        'ORDER', 'SETTLEMENT_REQUEST', 'SETTLEMENT_BATCH', 'MERCHANT_GUARANTEE',
        'TAKEOVER_CASE', 'MERCHANT_DEBT', 'COVERAGE_SNAPSHOT', 'RECOVERY'
    )),
    ADD CONSTRAINT ledger_journals_source_kind_check CHECK (source_kind IN (
        'CHAIN_EVENT', 'SIGNED_REQUEST', 'SAFE_BATCH', 'FULFILLMENT_EVIDENCE',
        'GOVERNED_EVIDENCE', 'RECONCILIATION'
    )),
    ADD CONSTRAINT ledger_journals_source_reference_hash_check
        CHECK (source_reference_hash ~ '^0x[0-9a-fA-F]{64}$'),
    ADD CONSTRAINT ledger_journals_chain_source_check CHECK (
        (source_kind = 'CHAIN_EVENT'
            AND source_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
            AND source_block_hash ~ '^0x[0-9a-fA-F]{64}$')
        OR (source_kind <> 'CHAIN_EVENT'
            AND source_tx_hash IS NULL
            AND source_block_hash IS NULL)
    ),
    ADD CONSTRAINT ledger_journals_event_type_check CHECK (event_type IN (
        'PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL',
        'ARBITRATION_DISPUTED', 'ARBITRATION_RESOLVED', 'FULFILLMENT_AVAILABLE',
        'SETTLEMENT_REQUESTED', 'SETTLEMENT_BATCHED', 'SETTLEMENT_SETTLED',
        'SETTLEMENT_BATCH_REVERSED', 'SETTLEMENT_FINALITY_REVERSED',
        'GUARANTEE_DEPOSITED', 'GUARANTEE_DEDUCTED',
        'TAKEOVER_FUNDED', 'MERCHANT_DEBT_CAPTURED', 'FUTURE_PROCEEDS_CAPTURED',
        'COVERAGE_RECONCILED'
    ));

CREATE INDEX ledger_journals_resource_idx
    ON core.ledger_journals (resource_type, resource_id, created_at, journal_id);

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
            account_id text, side text, amount numeric, balance_state text, backing_safe_address text
        )
        LEFT JOIN core.ledger_accounts account ON account.account_id = line.account_id
        WHERE account.account_id IS NULL OR line.side NOT IN ('DEBIT', 'CREDIT') OR line.amount <= 0
            OR line.balance_state NOT IN ('POSTED', 'LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED', 'DISPUTED')
            OR (
                line.backing_safe_address IS NOT NULL
                AND line.backing_safe_address !~ '^0x[0-9a-fA-F]{40}$'
            )
    ) THEN
        RAISE EXCEPTION 'InvalidLedgerLines' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_lines) AS line(
            account_id text, side text, amount numeric, balance_state text, backing_safe_address text
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
        journal_id, account_id, side, amount, balance_state, backing_safe_address
    )
    SELECT p_journal_id, line.account_id, line.side, line.amount, line.balance_state,
        lower(line.backing_safe_address)
    FROM jsonb_to_recordset(p_lines) AS line(
        account_id text, side text, amount numeric, balance_state text, backing_safe_address text
    );
    RETURN p_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION core.post_balanced_journal(
    p_journal_id text,
    p_event_key text,
    p_event_type text,
    p_order_id text,
    p_policy_version bigint,
    p_content_hash text,
    p_source_tx_hash text,
    p_source_block_hash text,
    p_reversal_of text,
    p_payload jsonb,
    p_lines jsonb
) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
    RETURN core.post_resource_balanced_journal(
        p_journal_id, p_event_key, p_event_type, 'ORDER', p_order_id,
        p_order_id, p_policy_version, p_content_hash,
        CASE WHEN p_event_type IN ('PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL')
            THEN p_source_tx_hash ELSE NULL END,
        CASE WHEN p_event_type IN ('PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL')
            THEN p_source_block_hash ELSE NULL END,
        CASE WHEN p_event_type IN ('PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL')
            THEN 'CHAIN_EVENT' ELSE 'FULFILLMENT_EVIDENCE' END,
        p_source_tx_hash, p_reversal_of, p_payload, p_lines
    );
END;
$$;

CREATE TABLE core.settlement_wallet_nonces (
    wallet_address text PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    next_nonce numeric(78, 0) NOT NULL DEFAULT 0 CHECK (next_nonce >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.settlement_intents (
    intent_id text PRIMARY KEY CHECK (intent_id ~ '^0x[0-9a-f]{64}$'),
    artifact_version text NOT NULL,
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    recipient_address text NOT NULL CHECK (
        recipient_address ~ '^0x[0-9a-f]{40}$'
        AND recipient_address <> '0x0000000000000000000000000000000000000000'
    ),
    rail text NOT NULL CHECK (rail IN (
        'MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT',
        'TAKEOVER_USDT', 'OPERATIONS_REIMBURSEMENT_USDT'
    )),
    asset text NOT NULL CHECK (asset IN ('USDT', 'NPL')),
    asset_address text NOT NULL CHECK (asset_address ~ '^0x[0-9a-f]{40}$'),
    safe_address text NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    items_hash text NOT NULL CHECK (items_hash ~ '^0x[0-9a-f]{64}$'),
    intent_digest text NOT NULL UNIQUE CHECK (intent_digest ~ '^0x[0-9a-f]{64}$'),
    nonce numeric(78, 0) NOT NULL CHECK (nonce >= 0),
    deadline timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('ISSUED', 'CONSUMED', 'EXPIRED', 'CANCELLED')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    consumed_at timestamptz,
    UNIQUE (wallet_address, nonce),
    UNIQUE (wallet_address, idempotency_key),
    CHECK ((rail = 'REWARD_NPL') = (asset = 'NPL')),
    CHECK (deadline > created_at),
    CHECK ((state = 'CONSUMED') = (consumed_at IS NOT NULL))
);

CREATE TABLE core.settlement_intent_items (
    intent_id text NOT NULL REFERENCES core.settlement_intents(intent_id),
    item_index integer NOT NULL CHECK (item_index >= 0),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    account_id text NOT NULL REFERENCES core.ledger_accounts(account_id),
    backing_safe_address text NOT NULL CHECK (backing_safe_address ~ '^0x[0-9a-f]{40}$'),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    item_hash text NOT NULL CHECK (item_hash ~ '^0x[0-9a-f]{64}$'),
    PRIMARY KEY (intent_id, item_index),
    UNIQUE (intent_id, order_id, account_id)
);

CREATE TABLE core.takeover_replacement_fulfillment_snapshots (
    snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^0x[0-9a-f]{64}$'),
    case_id text NOT NULL UNIQUE,
    order_id text NOT NULL UNIQUE,
    recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
    fulfillment_target_hash text NOT NULL REFERENCES core.fulfillment_targets(target_hash),
    policy_version bigint NOT NULL,
    snapshot_hash text NOT NULL UNIQUE CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$'),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL
);

CREATE TABLE core.governed_settlement_intent_approvals (
    intent_id text PRIMARY KEY REFERENCES core.settlement_intents(intent_id),
    rail text NOT NULL CHECK (rail IN ('TAKEOVER_USDT', 'OPERATIONS_REIMBURSEMENT_USDT')),
    resource_type text NOT NULL CHECK (resource_type IN ('TAKEOVER_CASE', 'MERCHANT_DEBT_RECOVERY')),
    resource_id text NOT NULL,
    takeover_case_id text REFERENCES core.takeover_cases(case_id),
    debt_recovery_id text,
    replacement_fulfillment_snapshot_id text
        REFERENCES core.takeover_replacement_fulfillment_snapshots(snapshot_id),
    action_digest text NOT NULL UNIQUE CHECK (action_digest ~ '^0x[0-9a-f]{64}$'),
    signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
    action_nonce numeric(78, 0) NOT NULL CHECK (action_nonce >= 0),
    action_deadline timestamptz NOT NULL,
    signature text NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]+$'),
    signature_hash text NOT NULL CHECK (signature_hash ~ '^0x[0-9a-f]{64}$'),
    action_payload jsonb NOT NULL CHECK (jsonb_typeof(action_payload) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (signer_address, action_nonce),
    CHECK (
        (rail = 'TAKEOVER_USDT' AND resource_type = 'TAKEOVER_CASE'
            AND resource_id = takeover_case_id AND debt_recovery_id IS NULL
            AND replacement_fulfillment_snapshot_id IS NOT NULL)
        OR (rail = 'OPERATIONS_REIMBURSEMENT_USDT'
            AND resource_type = 'MERCHANT_DEBT_RECOVERY'
            AND resource_id = debt_recovery_id AND takeover_case_id IS NULL
            AND replacement_fulfillment_snapshot_id IS NULL)
    )
);

CREATE TABLE core.settlement_requests (
    request_id text PRIMARY KEY CHECK (request_id ~ '^0x[0-9a-f]{64}$'),
    intent_id text NOT NULL UNIQUE REFERENCES core.settlement_intents(intent_id),
    artifact_version text NOT NULL,
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
    rail text NOT NULL CHECK (rail IN (
        'MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT',
        'TAKEOVER_USDT', 'OPERATIONS_REIMBURSEMENT_USDT'
    )),
    asset text NOT NULL CHECK (asset IN ('USDT', 'NPL')),
    asset_address text NOT NULL CHECK (asset_address ~ '^0x[0-9a-f]{40}$'),
    safe_address text NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    items_hash text NOT NULL CHECK (items_hash ~ '^0x[0-9a-f]{64}$'),
    intent_digest text NOT NULL UNIQUE CHECK (intent_digest ~ '^0x[0-9a-f]{64}$'),
    signature text NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]+$'),
    signature_hash text NOT NULL CHECK (signature_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('REQUESTED', 'BATCHED', 'SETTLED', 'RETRYABLE', 'QUARANTINED')),
    batch_id text,
    final_safe_tx_hash text,
    final_execution_tx_hash text,
    requested_at timestamptz NOT NULL,
    batched_at timestamptz,
    settled_at timestamptz,
    CONSTRAINT settlement_requests_batch_state_check
        CHECK (
            (state = 'REQUESTED' AND batch_id IS NULL)
            OR state = 'QUARANTINED'
            OR (state NOT IN ('REQUESTED', 'QUARANTINED') AND batch_id IS NOT NULL)
        ),
    CONSTRAINT settlement_requests_settled_at_check
        CHECK (state <> 'SETTLED' OR settled_at IS NOT NULL),
    CONSTRAINT settlement_requests_safe_tx_check
        CHECK (state <> 'SETTLED' OR final_safe_tx_hash IS NOT NULL),
    CONSTRAINT settlement_requests_execution_tx_check
        CHECK (state <> 'SETTLED' OR final_execution_tx_hash IS NOT NULL),
    CHECK (final_safe_tx_hash IS NULL OR final_safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    CHECK (final_execution_tx_hash IS NULL OR final_execution_tx_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE INDEX settlement_requests_owner_state_idx
    ON core.settlement_requests (wallet_address, state, requested_at, request_id);
CREATE INDEX settlement_requests_batch_idx
    ON core.settlement_requests (batch_id, state) WHERE batch_id IS NOT NULL;

CREATE TABLE core.settlement_request_items (
    request_id text NOT NULL REFERENCES core.settlement_requests(request_id),
    item_index integer NOT NULL CHECK (item_index >= 0),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    account_id text NOT NULL REFERENCES core.ledger_accounts(account_id),
    backing_safe_address text NOT NULL CHECK (backing_safe_address ~ '^0x[0-9a-f]{40}$'),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    requested_journal_id text NOT NULL UNIQUE REFERENCES core.ledger_journals(journal_id),
    batched_journal_id text UNIQUE REFERENCES core.ledger_journals(journal_id),
    settled_journal_id text UNIQUE REFERENCES core.ledger_journals(journal_id),
    PRIMARY KEY (request_id, item_index),
    UNIQUE (request_id, order_id, account_id)
);

CREATE TABLE core.safe_nonce_reservations (
    safe_address text NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
    safe_nonce numeric(78, 0) NOT NULL CHECK (safe_nonce >= 0),
    batch_id text NOT NULL UNIQUE,
    content_hash text NOT NULL CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('RESERVED', 'SUBMITTED', 'CONSUMED', 'REORGED', 'QUARANTINED')),
    reserved_at timestamptz NOT NULL,
    PRIMARY KEY (safe_address, safe_nonce)
);

CREATE TABLE core.settlement_request_item_transitions (
    transition_id text PRIMARY KEY,
    request_id text NOT NULL,
    request_item_index integer NOT NULL,
    batch_id text,
    transition_sequence integer NOT NULL CHECK (transition_sequence > 0),
    transition_type text NOT NULL CHECK (transition_type IN (
        'REQUESTED', 'BATCHED', 'SETTLED', 'BATCH_REVERSED', 'FINALITY_REVERSED'
    )),
    journal_id text NOT NULL UNIQUE REFERENCES core.ledger_journals(journal_id),
    created_at timestamptz NOT NULL,
    FOREIGN KEY (request_id, request_item_index)
        REFERENCES core.settlement_request_items(request_id, item_index),
    UNIQUE (request_id, request_item_index, transition_sequence)
);

CREATE TABLE core.settlement_batches (
    batch_id text PRIMARY KEY CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    artifact_version text NOT NULL,
    chain_id bigint NOT NULL CHECK (chain_id = 56),
    asset text NOT NULL CHECK (asset IN ('USDT', 'NPL')),
    asset_address text NOT NULL CHECK (asset_address ~ '^0x[0-9a-f]{40}$'),
    safe_address text NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
    safe_version text NOT NULL,
    safe_singleton_address text NOT NULL CHECK (safe_singleton_address ~ '^0x[0-9a-f]{40}$'),
    safe_singleton_code_hash text NOT NULL CHECK (safe_singleton_code_hash ~ '^0x[0-9a-f]{64}$'),
    safe_nonce numeric(78, 0) NOT NULL CHECK (safe_nonce >= 0),
    owner_set_hash text NOT NULL CHECK (owner_set_hash ~ '^0x[0-9a-f]{64}$'),
    safe_runtime_evidence_hash text NOT NULL CHECK (safe_runtime_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    safe_runtime_checked_at timestamptz NOT NULL,
    multisend_address text NOT NULL CHECK (multisend_address ~ '^0x[0-9a-f]{40}$'),
    multisend_code_hash text NOT NULL CHECK (multisend_code_hash ~ '^0x[0-9a-f]{64}$'),
    token_code_hash text NOT NULL CHECK (token_code_hash ~ '^0x[0-9a-f]{64}$'),
    token_transfer_conformance_evidence_hash text NOT NULL
        CHECK (token_transfer_conformance_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    item_count integer NOT NULL CHECK (item_count > 0),
    total_amount numeric(78, 0) NOT NULL CHECK (total_amount > 0),
    items_hash text NOT NULL CHECK (items_hash ~ '^0x[0-9a-f]{64}$'),
    content_hash text NOT NULL UNIQUE CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
    idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    multisend_transactions text NOT NULL CHECK (multisend_transactions ~ '^0x(?:[0-9a-fA-F]{2})+$'),
    multisend_calldata text NOT NULL CHECK (multisend_calldata ~ '^0x(?:[0-9a-fA-F]{2})+$'),
    safe_tx_data text NOT NULL CHECK (safe_tx_data ~ '^0x(?:[0-9a-fA-F]{2})+$'),
    safe_tx_hash text NOT NULL UNIQUE CHECK (safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    safe_tx_gas numeric(78, 0) NOT NULL CHECK (safe_tx_gas = 0),
    base_gas numeric(78, 0) NOT NULL CHECK (base_gas = 0),
    gas_price numeric(78, 0) NOT NULL CHECK (gas_price = 0),
    gas_token text NOT NULL CHECK (gas_token = '0x0000000000000000000000000000000000000000'),
    refund_receiver text NOT NULL CHECK (refund_receiver = '0x0000000000000000000000000000000000000000'),
    state text NOT NULL CHECK (state IN (
        'APPROVAL_PENDING', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'MINED',
        'SETTLED', 'FAILED', 'REORGED', 'RETRYABLE', 'QUARANTINED'
    )),
    approval_threshold integer NOT NULL CHECK (approval_threshold > 0),
    proposal_reference_hash text CHECK (
        proposal_reference_hash IS NULL OR proposal_reference_hash ~ '^0x[0-9a-f]{64}$'
    ),
    approval_evidence_hash text CHECK (
        approval_evidence_hash IS NULL OR approval_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    packed_signatures text CHECK (
        packed_signatures IS NULL OR packed_signatures ~ '^0x(?:[0-9a-fA-F]{2})+$'
    ),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    approved_at timestamptz,
    submitted_at timestamptz,
    settled_at timestamptz,
    CHECK (state <> 'SETTLED' OR settled_at IS NOT NULL),
    UNIQUE (safe_address, safe_nonce)
);

ALTER TABLE core.safe_nonce_reservations
    ADD CONSTRAINT safe_nonce_reservations_batch_fk
    FOREIGN KEY (batch_id) REFERENCES core.settlement_batches(batch_id);

ALTER TABLE core.settlement_request_item_transitions
    ADD CONSTRAINT settlement_request_item_transitions_batch_fk
    FOREIGN KEY (batch_id) REFERENCES core.settlement_batches(batch_id);

ALTER TABLE core.settlement_requests
    ADD CONSTRAINT settlement_requests_batch_fk
    FOREIGN KEY (batch_id) REFERENCES core.settlement_batches(batch_id);

CREATE TABLE core.settlement_batch_items (
    batch_id text NOT NULL REFERENCES core.settlement_batches(batch_id),
    item_index integer NOT NULL CHECK (item_index >= 0),
    request_id text NOT NULL REFERENCES core.settlement_requests(request_id),
    request_item_index integer NOT NULL,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    account_id text NOT NULL REFERENCES core.ledger_accounts(account_id),
    recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
    token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    transfer_calldata text NOT NULL CHECK (transfer_calldata ~ '^0x(?:[0-9a-fA-F]{2})+$'),
    item_hash text NOT NULL CHECK (item_hash ~ '^0x[0-9a-f]{64}$'),
    PRIMARY KEY (batch_id, item_index),
    UNIQUE (batch_id, request_id, request_item_index),
    FOREIGN KEY (request_id, request_item_index)
        REFERENCES core.settlement_request_items(request_id, item_index)
);

CREATE TABLE core.settlement_batch_approvals (
    batch_id text NOT NULL REFERENCES core.settlement_batches(batch_id),
    owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
    safe_tx_hash text NOT NULL CHECK (safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    signature text NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]+$'),
    signature_hash text NOT NULL CHECK (signature_hash ~ '^0x[0-9a-f]{64}$'),
    approved_at timestamptz NOT NULL,
    PRIMARY KEY (batch_id, owner_address)
);

CREATE TABLE core.settlement_execution_attempts (
    attempt_id text PRIMARY KEY,
    batch_id text NOT NULL REFERENCES core.settlement_batches(batch_id),
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    lease_token text NOT NULL UNIQUE,
    request_digest text NOT NULL CHECK (request_digest ~ '^0x[0-9a-f]{64}$'),
    exec_transaction_calldata text NOT NULL CHECK (exec_transaction_calldata ~ '^0x(?:[0-9a-fA-F]{2})+$'),
    safe_tx_hash text NOT NULL CHECK (safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    execution_tx_hash text UNIQUE CHECK (execution_tx_hash IS NULL OR execution_tx_hash ~ '^0x[0-9a-f]{64}$'),
    outer_sender text CHECK (outer_sender IS NULL OR outer_sender ~ '^0x[0-9a-f]{40}$'),
    outer_nonce numeric(78, 0) CHECK (outer_nonce IS NULL OR outer_nonce >= 0),
    replacement_for_attempt_id text REFERENCES core.settlement_execution_attempts(attempt_id),
    state text NOT NULL CHECK (state IN (
        'LEASED', 'SUBMITTED', 'MINED', 'SETTLED', 'REPLACED', 'FAILED', 'REORGED', 'QUARANTINED'
    )),
    leased_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    submitted_at timestamptz,
    updated_at timestamptz NOT NULL,
    UNIQUE (batch_id, attempt_number),
    UNIQUE (replacement_for_attempt_id),
    UNIQUE (outer_sender, outer_nonce, execution_tx_hash)
);

CREATE TABLE core.settlement_payment_reorg_exposures (
    exposure_id text PRIMARY KEY,
    payment_event_key text NOT NULL,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    request_id text NOT NULL,
    request_item_index integer NOT NULL,
    batch_id text REFERENCES core.settlement_batches(batch_id),
    previous_request_state text NOT NULL,
    previous_batch_state text,
    asset text NOT NULL CHECK (asset IN ('USDT', 'NPL')),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    final_safe_tx_hash text CHECK (
        final_safe_tx_hash IS NULL OR final_safe_tx_hash ~ '^0x[0-9a-f]{64}$'
    ),
    final_execution_tx_hash text CHECK (
        final_execution_tx_hash IS NULL OR final_execution_tx_hash ~ '^0x[0-9a-f]{64}$'
    ),
    reversal_journal_id text NOT NULL REFERENCES core.ledger_journals(journal_id),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    resolution_state text NOT NULL CHECK (resolution_state IN ('OPEN', 'RESOLVED')),
    created_at timestamptz NOT NULL,
    resolved_at timestamptz,
    resolution_evidence_hash text CHECK (
        resolution_evidence_hash IS NULL OR resolution_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    FOREIGN KEY (request_id, request_item_index)
        REFERENCES core.settlement_request_items(request_id, item_index),
    UNIQUE (payment_event_key, request_id, request_item_index),
    CHECK ((resolution_state = 'RESOLVED') = (resolved_at IS NOT NULL)),
    CHECK ((resolved_at IS NULL) = (resolution_evidence_hash IS NULL))
);

CREATE TABLE core.coverage_snapshots (
    snapshot_id text PRIMARY KEY,
    chain_id bigint NOT NULL CHECK (chain_id = 56),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    canonical boolean NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL,
    UNIQUE (block_number, block_hash)
);

CREATE TABLE core.coverage_snapshot_items (
    snapshot_id text NOT NULL REFERENCES core.coverage_snapshots(snapshot_id),
    safe_address text NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
    asset text NOT NULL CHECK (asset IN ('USDT', 'NPL')),
    verified_asset_balance numeric(78, 0) NOT NULL CHECK (verified_asset_balance >= 0),
    unsettled_liability numeric(78, 0) NOT NULL CHECK (unsettled_liability >= 0),
    coverage_met boolean NOT NULL,
    PRIMARY KEY (snapshot_id, safe_address, asset),
    CHECK (coverage_met = (verified_asset_balance >= unsettled_liability))
);

CREATE TABLE core.coverage_snapshot_canonicality (
    observation_id text PRIMARY KEY,
    snapshot_id text NOT NULL REFERENCES core.coverage_snapshots(snapshot_id),
    canonical boolean NOT NULL,
    observed_block_hash text NOT NULL CHECK (observed_block_hash ~ '^0x[0-9a-f]{64}$'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL,
    UNIQUE (snapshot_id, observed_block_hash, canonical)
);

CREATE TABLE core.breaker_events (
    breaker_event_id text PRIMARY KEY,
    scope text NOT NULL CHECK (scope IN ('NEW_PAYMENT', 'SECKILL_PURCHASE', 'NEW_SETTLEMENT_BATCH')),
    action text NOT NULL CHECK (action IN ('PAUSE', 'RESUME')),
    cause_type text NOT NULL CHECK (cause_type IN ('COVERAGE', 'GOVERNANCE', 'SECURITY', 'OPERATIONS')),
    cause_id text NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    policy_version bigint REFERENCES core.policy_snapshots(policy_version),
    changed_by text NOT NULL,
    changed_at timestamptz NOT NULL
);

CREATE TABLE core.breaker_causes (
    scope text NOT NULL CHECK (scope IN ('NEW_PAYMENT', 'SECKILL_PURCHASE', 'NEW_SETTLEMENT_BATCH')),
    cause_type text NOT NULL CHECK (cause_type IN ('COVERAGE', 'GOVERNANCE', 'SECURITY', 'OPERATIONS')),
    cause_id text NOT NULL,
    active boolean NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (scope, cause_type, cause_id)
);

CREATE TABLE core.merchant_guarantees (
    merchant_id text PRIMARY KEY REFERENCES core.merchants(merchant_id),
    backing_safe_address text NOT NULL CHECK (backing_safe_address ~ '^0x[0-9a-f]{40}$'),
    balance_usdt numeric(78, 0) NOT NULL CHECK (balance_usdt >= 0),
    minimum_usdt numeric(78, 0) NOT NULL CHECK (minimum_usdt = 1000000000000000000000),
    source_evidence_hash text NOT NULL CHECK (source_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    updated_at timestamptz NOT NULL
);

CREATE TABLE core.merchant_guarantee_deposit_submissions (
    deposit_id text PRIMARY KEY,
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    merchant_wallet text NOT NULL CHECK (merchant_wallet ~ '^0x[0-9a-f]{40}$'),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    chain_id bigint NOT NULL CHECK (chain_id = 56),
    token_address text NOT NULL CHECK (
        token_address = '0x55d398326f99059ff775485246999027b3197955'
    ),
    operations_safe_address text NOT NULL CHECK (
        operations_safe_address ~ '^0x[0-9a-f]{40}$'
        AND operations_safe_address <> '0x0000000000000000000000000000000000000000'
    ),
    expected_amount_usdt numeric(78, 0) NOT NULL CHECK (expected_amount_usdt > 0),
    transaction_hash text NOT NULL UNIQUE CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'QUARANTINED')),
    observed_block_number bigint CHECK (observed_block_number IS NULL OR observed_block_number >= 0),
    observed_block_hash text CHECK (observed_block_hash IS NULL OR observed_block_hash ~ '^0x[0-9a-f]{64}$'),
    observed_log_index integer CHECK (observed_log_index IS NULL OR observed_log_index >= 0),
    confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    transfer_evidence_hash text CHECK (transfer_evidence_hash IS NULL OR transfer_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    final_journal_id text UNIQUE REFERENCES core.ledger_journals(journal_id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
    submitted_by text NOT NULL CHECK (submitted_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    last_finality_check_at timestamptz,
    finalized_at timestamptz,
    UNIQUE (submitted_by, idempotency_key),
    CHECK ((state = 'FINAL') = (finalized_at IS NOT NULL)),
    CHECK (
        (state = 'SUBMITTED' AND observed_block_number IS NULL AND observed_block_hash IS NULL
            AND observed_log_index IS NULL AND transfer_evidence_hash IS NULL)
        OR (state <> 'SUBMITTED' AND observed_block_number IS NOT NULL AND observed_block_hash IS NOT NULL
            AND observed_log_index IS NOT NULL AND transfer_evidence_hash IS NOT NULL)
    )
);

CREATE INDEX merchant_guarantee_deposit_finality_idx
    ON core.merchant_guarantee_deposit_submissions (last_finality_check_at, updated_at, deposit_id)
    WHERE state IN ('SUBMITTED', 'MINED', 'FINAL', 'REORGED');

CREATE TABLE core.merchant_guarantee_deposit_transitions (
    transition_id text PRIMARY KEY,
    deposit_id text NOT NULL REFERENCES core.merchant_guarantee_deposit_submissions(deposit_id),
    event_type text NOT NULL CHECK (event_type IN ('SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'QUARANTINED')),
    previous_state text CHECK (previous_state IS NULL OR previous_state IN ('SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'QUARANTINED')),
    block_number bigint CHECK (block_number IS NULL OR block_number >= 0),
    block_hash text CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
    canonical_block_hash text CHECK (canonical_block_hash IS NULL OR canonical_block_hash ~ '^0x[0-9a-f]{64}$'),
    log_index integer CHECK (log_index IS NULL OR log_index >= 0),
    confirmations integer NOT NULL CHECK (confirmations >= 0),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL,
    UNIQUE (deposit_id, event_type, evidence_hash)
);

CREATE TABLE core.merchant_guarantee_reorg_exposures (
    exposure_id text PRIMARY KEY,
    deposit_id text NOT NULL REFERENCES core.merchant_guarantee_deposit_submissions(deposit_id),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    journal_id text NOT NULL REFERENCES core.ledger_journals(journal_id),
    amount_usdt numeric(78, 0) NOT NULL CHECK (amount_usdt > 0),
    previous_block_hash text NOT NULL CHECK (previous_block_hash ~ '^0x[0-9a-f]{64}$'),
    canonical_block_hash text NOT NULL CHECK (canonical_block_hash ~ '^0x[0-9a-f]{64}$'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('OPEN', 'RESOLVED')),
    opened_at timestamptz NOT NULL,
    resolved_at timestamptz,
    resolution_evidence_hash text CHECK (
        resolution_evidence_hash IS NULL OR resolution_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    UNIQUE (deposit_id, previous_block_hash, canonical_block_hash),
    CHECK ((state = 'RESOLVED') = (resolved_at IS NOT NULL)),
    CHECK ((state = 'RESOLVED') = (resolution_evidence_hash IS NOT NULL))
);

CREATE TABLE core.merchant_debts (
    merchant_id text PRIMARY KEY REFERENCES core.merchants(merchant_id),
    incurred_usdt numeric(78, 0) NOT NULL CHECK (incurred_usdt >= 0),
    recovered_usdt numeric(78, 0) NOT NULL CHECK (recovered_usdt >= 0),
    outstanding_usdt numeric(78, 0) NOT NULL CHECK (outstanding_usdt >= 0),
    latest_evidence_hash text NOT NULL CHECK (latest_evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
    updated_at timestamptz NOT NULL,
    CHECK (incurred_usdt = recovered_usdt + outstanding_usdt)
);

CREATE TABLE core.merchant_debt_recoveries (
    recovery_id text PRIMARY KEY,
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    case_id text NOT NULL REFERENCES core.takeover_cases(case_id),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    amount_usdt numeric(78, 0) NOT NULL CHECK (amount_usdt > 0),
    operations_safe_address text NOT NULL CHECK (
        operations_safe_address ~ '^0x[0-9a-f]{40}$'
        AND operations_safe_address <> '0x0000000000000000000000000000000000000000'
    ),
    backing_safe_address text NOT NULL CHECK (
        backing_safe_address ~ '^0x[0-9a-f]{40}$'
        AND backing_safe_address <> '0x0000000000000000000000000000000000000000'
    ),
    journal_id text NOT NULL REFERENCES core.ledger_journals(journal_id),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
    recovered_at timestamptz NOT NULL,
    reversed_at timestamptz,
    reversal_evidence_hash text CHECK (
        reversal_evidence_hash IS NULL OR reversal_evidence_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    UNIQUE (case_id, order_id, journal_id),
    CHECK ((reversed_at IS NULL) = (reversal_evidence_hash IS NULL))
);

ALTER TABLE core.governed_settlement_intent_approvals
    ADD CONSTRAINT governed_settlement_debt_recovery_fk
    FOREIGN KEY (debt_recovery_id) REFERENCES core.merchant_debt_recoveries(recovery_id);

CREATE TABLE core.takeover_funding_items (
    funding_item_id text PRIMARY KEY,
    case_id text NOT NULL REFERENCES core.takeover_cases(case_id),
    source_type text NOT NULL CHECK (source_type IN (
        'GUARANTEE', 'FROZEN_RECEIVABLE', 'FUTURE_PROCEEDS', 'PLATFORM_ADVANCE'
    )),
    amount_usdt numeric(78, 0) NOT NULL CHECK (amount_usdt > 0),
    journal_id text NOT NULL UNIQUE REFERENCES core.ledger_journals(journal_id),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL
);

CREATE TABLE core.takeover_funding_commands (
    command_id text PRIMARY KEY,
    case_id text NOT NULL REFERENCES core.takeover_cases(case_id),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    old_value_hash text NOT NULL CHECK (old_value_hash ~ '^0x[0-9a-f]{64}$'),
    new_value_hash text NOT NULL CHECK (new_value_hash ~ '^0x[0-9a-f]{64}$'),
    action_digest text NOT NULL UNIQUE CHECK (action_digest ~ '^0x[0-9a-f]{64}$'),
    secondary_signer text NOT NULL CHECK (secondary_signer ~ '^0x[0-9a-f]{40}$'),
    secondary_signature_hash text NOT NULL CHECK (secondary_signature_hash ~ '^0x[0-9a-f]{64}$'),
    approval_nonce numeric(78, 0) NOT NULL CHECK (approval_nonce >= 0),
    approval_deadline timestamptz NOT NULL,
    governance_safe_address text NOT NULL CHECK (governance_safe_address ~ '^0x[0-9a-f]{40}$'),
    safe_tx_hash text NOT NULL CHECK (safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    safe_approval_evidence_hash text NOT NULL CHECK (safe_approval_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    safe_owner_approvals jsonb NOT NULL CHECK (
        jsonb_typeof(safe_owner_approvals) = 'array' AND jsonb_array_length(safe_owner_approvals) > 0
    ),
    correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key),
    UNIQUE (secondary_signer, approval_nonce)
);

ALTER TABLE core.takeover_cases
    DROP CONSTRAINT takeover_cases_funding_check,
    ADD COLUMN future_proceeds_used_usdt numeric(78, 0) NOT NULL DEFAULT 0
        CHECK (future_proceeds_used_usdt >= 0),
    ADD COLUMN platform_advance_usdt numeric(78, 0) NOT NULL DEFAULT 0
        CHECK (platform_advance_usdt >= 0),
    ADD COLUMN platform_advance_safe_address text
        CHECK (platform_advance_safe_address IS NULL OR (
            platform_advance_safe_address ~ '^0x[0-9a-f]{40}$'
            AND platform_advance_safe_address <> '0x0000000000000000000000000000000000000000'
        )),
    ADD CONSTRAINT takeover_cases_identity_unique UNIQUE (case_id, order_id, policy_version),
    ADD CONSTRAINT takeover_cases_advance_safe_unique UNIQUE (case_id, platform_advance_safe_address),
    ADD CONSTRAINT takeover_cases_funding_check CHECK (
        (required_usdt IS NULL AND guarantee_used_usdt = 0 AND merchant_available_used_usdt = 0
            AND future_proceeds_used_usdt = 0 AND platform_advance_usdt = 0
            AND platform_advance_safe_address IS NULL)
        OR
        (required_usdt > 0
            AND guarantee_used_usdt + merchant_available_used_usdt
                + future_proceeds_used_usdt + platform_advance_usdt = required_usdt
            AND ((platform_advance_usdt = 0 AND platform_advance_safe_address IS NULL)
                OR (platform_advance_usdt > 0 AND platform_advance_safe_address IS NOT NULL)))
    );

ALTER TABLE core.orders
    ADD CONSTRAINT orders_fulfillment_target_identity_unique
    UNIQUE (order_id, fulfillment_target_hash);

ALTER TABLE core.takeover_replacement_fulfillment_snapshots
    ADD CONSTRAINT takeover_replacement_case_identity_fk
        FOREIGN KEY (case_id, order_id, policy_version)
        REFERENCES core.takeover_cases(case_id, order_id, policy_version),
    ADD CONSTRAINT takeover_replacement_order_target_fk
        FOREIGN KEY (order_id, fulfillment_target_hash)
        REFERENCES core.orders(order_id, fulfillment_target_hash);

ALTER TABLE core.merchant_debt_recoveries
    ADD CONSTRAINT merchant_debt_recovery_advance_safe_fk
    FOREIGN KEY (case_id, operations_safe_address)
    REFERENCES core.takeover_cases(case_id, platform_advance_safe_address);

CREATE FUNCTION core.protect_settlement_batch_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
        OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version
        OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
        OR NEW.asset IS DISTINCT FROM OLD.asset
        OR NEW.asset_address IS DISTINCT FROM OLD.asset_address
        OR NEW.safe_address IS DISTINCT FROM OLD.safe_address
        OR NEW.safe_version IS DISTINCT FROM OLD.safe_version
        OR NEW.safe_singleton_address IS DISTINCT FROM OLD.safe_singleton_address
        OR NEW.safe_singleton_code_hash IS DISTINCT FROM OLD.safe_singleton_code_hash
        OR NEW.safe_nonce IS DISTINCT FROM OLD.safe_nonce
        OR NEW.owner_set_hash IS DISTINCT FROM OLD.owner_set_hash
        OR NEW.safe_runtime_evidence_hash IS DISTINCT FROM OLD.safe_runtime_evidence_hash
        OR NEW.safe_runtime_checked_at IS DISTINCT FROM OLD.safe_runtime_checked_at
        OR NEW.multisend_address IS DISTINCT FROM OLD.multisend_address
        OR NEW.multisend_code_hash IS DISTINCT FROM OLD.multisend_code_hash
        OR NEW.token_code_hash IS DISTINCT FROM OLD.token_code_hash
        OR NEW.token_transfer_conformance_evidence_hash IS DISTINCT FROM OLD.token_transfer_conformance_evidence_hash
        OR NEW.item_count IS DISTINCT FROM OLD.item_count
        OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
        OR NEW.items_hash IS DISTINCT FROM OLD.items_hash
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.multisend_transactions IS DISTINCT FROM OLD.multisend_transactions
        OR NEW.multisend_calldata IS DISTINCT FROM OLD.multisend_calldata
        OR NEW.safe_tx_data IS DISTINCT FROM OLD.safe_tx_data
        OR NEW.safe_tx_hash IS DISTINCT FROM OLD.safe_tx_hash
        OR NEW.safe_tx_gas IS DISTINCT FROM OLD.safe_tx_gas
        OR NEW.base_gas IS DISTINCT FROM OLD.base_gas
        OR NEW.gas_price IS DISTINCT FROM OLD.gas_price
        OR NEW.gas_token IS DISTINCT FROM OLD.gas_token
        OR NEW.refund_receiver IS DISTINCT FROM OLD.refund_receiver
        OR NEW.approval_threshold IS DISTINCT FROM OLD.approval_threshold
        OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'ImmutableSettlementBatch' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER settlement_batches_content_immutable
    BEFORE UPDATE ON core.settlement_batches
    FOR EACH ROW EXECUTE FUNCTION core.protect_settlement_batch_content();
CREATE TRIGGER settlement_batches_no_delete
    BEFORE DELETE ON core.settlement_batches
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER settlement_batch_items_no_mutation
    BEFORE UPDATE OR DELETE ON core.settlement_batch_items
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER settlement_request_items_no_delete
    BEFORE DELETE ON core.settlement_request_items
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE FUNCTION core.protect_settlement_intent_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
        OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version
        OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
        OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
        OR NEW.rail IS DISTINCT FROM OLD.rail
        OR NEW.asset IS DISTINCT FROM OLD.asset
        OR NEW.asset_address IS DISTINCT FROM OLD.asset_address
        OR NEW.safe_address IS DISTINCT FROM OLD.safe_address
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

CREATE FUNCTION core.protect_settlement_request_content() RETURNS trigger
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
        OR NEW.safe_address IS DISTINCT FROM OLD.safe_address
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

CREATE FUNCTION core.protect_settlement_request_item_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.request_id IS DISTINCT FROM OLD.request_id
        OR NEW.item_index IS DISTINCT FROM OLD.item_index
        OR NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.backing_safe_address IS DISTINCT FROM OLD.backing_safe_address
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.requested_journal_id IS DISTINCT FROM OLD.requested_journal_id
    THEN
        RAISE EXCEPTION 'ImmutableSettlementRequestItem' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION core.protect_merchant_debt_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.recovery_id IS DISTINCT FROM OLD.recovery_id
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.case_id IS DISTINCT FROM OLD.case_id
        OR NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.amount_usdt IS DISTINCT FROM OLD.amount_usdt
        OR NEW.operations_safe_address IS DISTINCT FROM OLD.operations_safe_address
        OR NEW.backing_safe_address IS DISTINCT FROM OLD.backing_safe_address
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

CREATE FUNCTION core.protect_takeover_funding_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.required_usdt IS NOT NULL AND (
        NEW.required_usdt IS DISTINCT FROM OLD.required_usdt
        OR NEW.guarantee_used_usdt IS DISTINCT FROM OLD.guarantee_used_usdt
        OR NEW.merchant_available_used_usdt IS DISTINCT FROM OLD.merchant_available_used_usdt
        OR NEW.future_proceeds_used_usdt IS DISTINCT FROM OLD.future_proceeds_used_usdt
        OR NEW.platform_advance_usdt IS DISTINCT FROM OLD.platform_advance_usdt
        OR NEW.platform_advance_safe_address IS DISTINCT FROM OLD.platform_advance_safe_address
        OR NEW.merchant_debt_usdt IS DISTINCT FROM OLD.merchant_debt_usdt
    ) THEN
        RAISE EXCEPTION 'ImmutableTakeoverFundingSnapshot' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION core.protect_merchant_guarantee_deposit_submission() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deposit_id IS DISTINCT FROM OLD.deposit_id
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.merchant_wallet IS DISTINCT FROM OLD.merchant_wallet
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
        OR NEW.token_address IS DISTINCT FROM OLD.token_address
        OR NEW.operations_safe_address IS DISTINCT FROM OLD.operations_safe_address
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

CREATE FUNCTION core.protect_merchant_guarantee_reorg_exposure() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.exposure_id IS DISTINCT FROM OLD.exposure_id
        OR NEW.deposit_id IS DISTINCT FROM OLD.deposit_id
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.journal_id IS DISTINCT FROM OLD.journal_id
        OR NEW.amount_usdt IS DISTINCT FROM OLD.amount_usdt
        OR NEW.previous_block_hash IS DISTINCT FROM OLD.previous_block_hash
        OR NEW.canonical_block_hash IS DISTINCT FROM OLD.canonical_block_hash
        OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
        OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    THEN
        RAISE EXCEPTION 'ImmutableGuaranteeReorgExposure' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        OLD.state = 'OPEN' AND NEW.state = 'RESOLVED'
    ) THEN
        RAISE EXCEPTION 'InvalidGuaranteeReorgExposureTransition' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state IS NOT DISTINCT FROM OLD.state AND (
        NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
        OR NEW.resolution_evidence_hash IS DISTINCT FROM OLD.resolution_evidence_hash
    ) THEN
        RAISE EXCEPTION 'InvalidGuaranteeReorgExposureTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER settlement_intents_content_immutable
    BEFORE UPDATE ON core.settlement_intents
    FOR EACH ROW EXECUTE FUNCTION core.protect_settlement_intent_content();
CREATE TRIGGER settlement_intents_no_delete
    BEFORE DELETE ON core.settlement_intents
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER settlement_intent_items_no_mutation
    BEFORE UPDATE OR DELETE ON core.settlement_intent_items
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER settlement_requests_content_immutable
    BEFORE UPDATE ON core.settlement_requests
    FOR EACH ROW EXECUTE FUNCTION core.protect_settlement_request_content();
CREATE TRIGGER settlement_requests_no_delete
    BEFORE DELETE ON core.settlement_requests
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER settlement_request_items_content_immutable
    BEFORE UPDATE ON core.settlement_request_items
    FOR EACH ROW EXECUTE FUNCTION core.protect_settlement_request_item_content();
CREATE TRIGGER takeover_replacement_fulfillment_snapshots_no_mutation
    BEFORE UPDATE OR DELETE ON core.takeover_replacement_fulfillment_snapshots
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER takeover_funding_snapshot_immutable
    BEFORE UPDATE ON core.takeover_cases
    FOR EACH ROW EXECUTE FUNCTION core.protect_takeover_funding_snapshot();
CREATE TRIGGER merchant_debt_recoveries_content_immutable
    BEFORE UPDATE ON core.merchant_debt_recoveries
    FOR EACH ROW EXECUTE FUNCTION core.protect_merchant_debt_recovery();
CREATE TRIGGER merchant_debt_recoveries_no_delete
    BEFORE DELETE ON core.merchant_debt_recoveries
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER merchant_guarantee_deposit_transitions_no_mutation
    BEFORE UPDATE OR DELETE ON core.merchant_guarantee_deposit_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER merchant_guarantee_deposit_submissions_content_immutable
    BEFORE UPDATE ON core.merchant_guarantee_deposit_submissions
    FOR EACH ROW EXECUTE FUNCTION core.protect_merchant_guarantee_deposit_submission();
CREATE TRIGGER merchant_guarantee_deposit_submissions_no_delete
    BEFORE DELETE ON core.merchant_guarantee_deposit_submissions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER merchant_guarantee_reorg_exposures_no_delete
    BEFORE DELETE ON core.merchant_guarantee_reorg_exposures
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER merchant_guarantee_reorg_exposures_content_immutable
    BEFORE UPDATE ON core.merchant_guarantee_reorg_exposures
    FOR EACH ROW EXECUTE FUNCTION core.protect_merchant_guarantee_reorg_exposure();
CREATE TRIGGER governed_settlement_intent_approvals_no_mutation
    BEFORE UPDATE OR DELETE ON core.governed_settlement_intent_approvals
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER settlement_request_item_transitions_no_mutation
    BEFORE UPDATE OR DELETE ON core.settlement_request_item_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER settlement_payment_reorg_exposures_no_delete
    BEFORE DELETE ON core.settlement_payment_reorg_exposures
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER settlement_batch_approvals_no_mutation
    BEFORE UPDATE OR DELETE ON core.settlement_batch_approvals
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER coverage_snapshots_no_mutation
    BEFORE UPDATE OR DELETE ON core.coverage_snapshots
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER coverage_snapshot_items_no_mutation
    BEFORE UPDATE OR DELETE ON core.coverage_snapshot_items
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER coverage_snapshot_canonicality_no_mutation
    BEFORE UPDATE OR DELETE ON core.coverage_snapshot_canonicality
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER takeover_funding_commands_no_mutation
    BEFORE UPDATE OR DELETE ON core.takeover_funding_commands
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
