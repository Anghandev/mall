ALTER TABLE core.skus
    DROP CONSTRAINT skus_check1,
    ADD COLUMN stock_seckill_locked bigint NOT NULL DEFAULT 0
        CHECK (stock_seckill_locked >= 0),
    ADD CONSTRAINT skus_inventory_balance_check
        CHECK (stock_available + stock_reserved + stock_seckill_locked <= stock_total);

CREATE TABLE core.seckill_governance_actions (
    action_id text PRIMARY KEY CHECK (action_id ~ '^0x[0-9a-f]{64}$'),
    session_id text NOT NULL CHECK (session_id ~ '^0x[0-9a-f]{64}$'),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    action_kind text NOT NULL CHECK (action_kind IN (
        'OPEN_SESSION', 'FORCE_CLOSE', 'RESUME_PURCHASES', 'PRIZE_INJECTION'
    )),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    governance_safe_address text NOT NULL CHECK (governance_safe_address ~ '^0x[0-9a-f]{40}$'),
    target_address text NOT NULL CHECK (target_address ~ '^0x[0-9a-f]{40}$'),
    calldata text NOT NULL CHECK (calldata ~ '^0x[0-9a-f]+$'),
    calldata_hash text NOT NULL CHECK (calldata_hash ~ '^0x[0-9a-f]{64}$'),
    old_value_hash text NOT NULL CHECK (old_value_hash ~ '^0x[0-9a-f]{64}$'),
    new_value_hash text NOT NULL CHECK (new_value_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN (
        'DRAFT', 'SECONDARY_SIGNED', 'PENDING_PROPOSAL', 'SAFE_PROPOSED',
        'MINED', 'FINAL', 'REORGED', 'FAILED', 'CANCELLED'
    )),
    safe_nonce numeric(78, 0) CHECK (safe_nonce IS NULL OR safe_nonce >= 0),
    safe_tx_hash text CHECK (safe_tx_hash IS NULL OR safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    proposal_hash text CHECK (proposal_hash IS NULL OR proposal_hash ~ '^0x[0-9a-f]{64}$'),
    execution_tx_hash text CHECK (execution_tx_hash IS NULL OR execution_tx_hash ~ '^0x[0-9a-f]{64}$'),
    block_number bigint CHECK (block_number IS NULL OR block_number >= 0),
    block_hash text CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
    confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    canonical boolean,
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    secondary_signer text CHECK (secondary_signer IS NULL OR secondary_signer ~ '^0x[0-9a-f]{40}$'),
    secondary_signature_hash text CHECK (
        secondary_signature_hash IS NULL OR secondary_signature_hash ~ '^0x[0-9a-f]{64}$'
    ),
    approval_nonce numeric(78, 0) CHECK (approval_nonce IS NULL OR approval_nonce >= 0),
    approval_deadline timestamptz,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key),
    UNIQUE (secondary_signer, approval_nonce),
    CHECK (
        (state = 'DRAFT' AND secondary_signer IS NULL AND approval_nonce IS NULL
            AND approval_deadline IS NULL AND secondary_signature_hash IS NULL)
        OR (state <> 'DRAFT')
    )
);

CREATE INDEX seckill_governance_actions_pending_idx
    ON core.seckill_governance_actions (state, updated_at, action_id)
    WHERE state IN ('PENDING_PROPOSAL', 'SAFE_PROPOSED', 'MINED', 'FINAL');

CREATE TABLE core.seckill_session_plans (
    session_id text PRIMARY KEY CHECK (session_id ~ '^0x[0-9a-f]{64}$'),
    action_id text NOT NULL UNIQUE REFERENCES core.seckill_governance_actions(action_id),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    product_id text NOT NULL REFERENCES core.products(product_id),
    sku_id text NOT NULL REFERENCES core.skus(sku_id),
    product_policy_hash text NOT NULL CHECK (product_policy_hash ~ '^0x[0-9a-f]{64}$'),
    rules_content_hash text NOT NULL CHECK (rules_content_hash ~ '^0x[0-9a-f]{64}$'),
    starts_at timestamptz NOT NULL,
    main_deadline timestamptz NOT NULL,
    relay_deadline timestamptz NOT NULL,
    inventory bigint NOT NULL CHECK (inventory > 0),
    seckill_list_price_usdt numeric(78, 0) NOT NULL CHECK (seckill_list_price_usdt > 0),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    inventory_lock_state text NOT NULL CHECK (inventory_lock_state IN ('LOCKED', 'RELEASED')),
    released_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (main_deadline = starts_at + interval '60 minutes'),
    CHECK (relay_deadline = starts_at + interval '60 seconds'),
    CHECK (relay_deadline <= main_deadline),
    CHECK ((inventory_lock_state = 'RELEASED') = (released_at IS NOT NULL))
);

CREATE TABLE core.seckill_prize_injections (
    injection_id text PRIMARY KEY CHECK (injection_id ~ '^0x[0-9a-f]{64}$'),
    action_id text NOT NULL UNIQUE REFERENCES core.seckill_governance_actions(action_id),
    session_id text NOT NULL REFERENCES core.seckill_sessions(session_id),
    amount_usdt numeric(78, 0) NOT NULL CHECK (amount_usdt > 0),
    operations_safe_address text NOT NULL CHECK (operations_safe_address ~ '^0x[0-9a-f]{40}$'),
    custody_safe_address text NOT NULL CHECK (custody_safe_address ~ '^0x[0-9a-f]{40}$'),
    token_address text NOT NULL CHECK (
        token_address = '0x55d398326f99059ff775485246999027b3197955'
    ),
    final_journal_id text UNIQUE REFERENCES core.ledger_journals(journal_id),
    reversal_journal_id text UNIQUE REFERENCES core.ledger_journals(journal_id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE core.seckill_governance_transitions (
    transition_id text PRIMARY KEY CHECK (transition_id ~ '^0x[0-9a-f]{64}$'),
    action_id text NOT NULL REFERENCES core.seckill_governance_actions(action_id),
    from_state text,
    to_state text NOT NULL,
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    recorded_at timestamptz NOT NULL
);

ALTER TABLE core.seckill_sessions
    ADD COLUMN governance_action_id text UNIQUE REFERENCES core.seckill_governance_actions(action_id),
    ADD COLUMN rules_content_hash text CHECK (
        rules_content_hash IS NULL OR rules_content_hash ~ '^0x[0-9a-f]{64}$'
    ),
    ADD COLUMN publication_tx_hash text CHECK (
        publication_tx_hash IS NULL OR publication_tx_hash ~ '^0x[0-9a-f]{64}$'
    );

ALTER TABLE core.ledger_journals
    DROP CONSTRAINT ledger_journals_resource_type_check,
    DROP CONSTRAINT ledger_journals_event_type_check,
    DROP CONSTRAINT ledger_journals_check,
    ADD CONSTRAINT ledger_journals_resource_type_check CHECK (resource_type IN (
        'ORDER', 'SETTLEMENT_REQUEST', 'SETTLEMENT_BATCH', 'MERCHANT_GUARANTEE',
        'TAKEOVER_CASE', 'MERCHANT_DEBT', 'COVERAGE_SNAPSHOT', 'RECOVERY',
        'SECKILL_SESSION'
    )),
    ADD CONSTRAINT ledger_journals_event_type_check CHECK (event_type IN (
        'PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL',
        'ARBITRATION_DISPUTED', 'ARBITRATION_RESOLVED', 'FULFILLMENT_AVAILABLE',
        'SETTLEMENT_REQUESTED', 'SETTLEMENT_BATCHED', 'SETTLEMENT_SETTLED',
        'SETTLEMENT_BATCH_REVERSED', 'SETTLEMENT_FINALITY_REVERSED',
        'GUARANTEE_DEPOSITED', 'GUARANTEE_DEDUCTED',
        'TAKEOVER_FUNDED', 'MERCHANT_DEBT_CAPTURED', 'FUTURE_PROCEEDS_CAPTURED',
        'COVERAGE_RECONCILED', 'SECKILL_PRIZE_INJECTED',
        'SECKILL_PRIZE_INJECTION_REVERSED'
    )),
    ADD CONSTRAINT ledger_journals_reversal_check CHECK (
        (event_type IN ('PAYMENT_REORG_REVERSAL', 'SECKILL_PRIZE_INJECTION_REVERSED'))
            = (reversal_of IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION core.consume_inventory_reservation_at(
    p_reservation_id text,
    p_order_id text,
    p_consumed_at timestamptz
) RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    reservation core.inventory_reservations;
BEGIN
    SELECT * INTO reservation FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id FOR UPDATE;
    IF NOT FOUND OR reservation.state <> 'ACTIVE' OR reservation.expires_at <= p_consumed_at THEN
        RAISE EXCEPTION 'ReservationUnavailable' USING ERRCODE = 'P0001';
    END IF;
    IF reservation.classification = 'SECKILL' THEN
        UPDATE core.seckill_sessions
        SET reserved = reserved - reservation.quantity,
            sold = sold + reservation.quantity,
            updated_at = clock_timestamp()
        WHERE session_id = reservation.session_id;
        UPDATE core.skus sku
        SET stock_total = stock_total - reservation.quantity,
            stock_seckill_locked = stock_seckill_locked - reservation.quantity
        FROM core.seckill_sessions session
        WHERE session.session_id = reservation.session_id
          AND session.sku_id = sku.sku_id
          AND session.governance_action_id IS NOT NULL;
    ELSE
        UPDATE core.skus
        SET stock_total = stock_total - reservation.quantity,
            stock_reserved = stock_reserved - reservation.quantity
        WHERE sku_id = reservation.sku_id;
    END IF;
    UPDATE core.inventory_reservations
    SET state = 'CONSUMED', consumed_order_id = p_order_id, updated_at = clock_timestamp()
    WHERE reservation_id = p_reservation_id RETURNING * INTO reservation;
    RETURN reservation;
END;
$$;

CREATE OR REPLACE FUNCTION core.restore_reorged_inventory_reservation(p_reservation_id text)
RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    reservation core.inventory_reservations;
BEGIN
    SELECT * INTO reservation FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'UnknownReservation' USING ERRCODE = 'P0001'; END IF;
    IF reservation.state = 'ACTIVE' THEN RETURN reservation; END IF;
    IF reservation.state <> 'CONSUMED' THEN
        RAISE EXCEPTION 'InvalidReservationState' USING ERRCODE = 'P0001';
    END IF;
    IF reservation.classification = 'SECKILL' THEN
        UPDATE core.seckill_sessions
        SET sold = sold - reservation.quantity,
            reserved = reserved + reservation.quantity,
            updated_at = clock_timestamp()
        WHERE session_id = reservation.session_id;
        UPDATE core.skus sku
        SET stock_total = stock_total + reservation.quantity,
            stock_seckill_locked = stock_seckill_locked + reservation.quantity
        FROM core.seckill_sessions session
        WHERE session.session_id = reservation.session_id
          AND session.sku_id = sku.sku_id
          AND session.governance_action_id IS NOT NULL;
    ELSE
        UPDATE core.skus
        SET stock_total = stock_total + reservation.quantity,
            stock_reserved = stock_reserved + reservation.quantity
        WHERE sku_id = reservation.sku_id;
    END IF;
    UPDATE core.inventory_reservations
    SET state = 'ACTIVE', consumed_order_id = NULL, updated_at = clock_timestamp()
    WHERE reservation_id = p_reservation_id RETURNING * INTO reservation;
    RETURN reservation;
END;
$$;

CREATE OR REPLACE FUNCTION core.consume_reorged_inventory_reservation(
    p_reservation_id text,
    p_order_id text
) RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    reservation core.inventory_reservations;
BEGIN
    SELECT * INTO reservation FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id FOR UPDATE;
    IF NOT FOUND OR reservation.state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'ReservationUnavailable' USING ERRCODE = 'P0001';
    END IF;
    IF reservation.classification = 'SECKILL' THEN
        UPDATE core.seckill_sessions
        SET reserved = reserved - reservation.quantity,
            sold = sold + reservation.quantity,
            updated_at = clock_timestamp()
        WHERE session_id = reservation.session_id;
        UPDATE core.skus sku
        SET stock_total = stock_total - reservation.quantity,
            stock_seckill_locked = stock_seckill_locked - reservation.quantity
        FROM core.seckill_sessions session
        WHERE session.session_id = reservation.session_id
          AND session.sku_id = sku.sku_id
          AND session.governance_action_id IS NOT NULL;
    ELSE
        UPDATE core.skus
        SET stock_total = stock_total - reservation.quantity,
            stock_reserved = stock_reserved - reservation.quantity
        WHERE sku_id = reservation.sku_id;
    END IF;
    UPDATE core.inventory_reservations
    SET state = 'CONSUMED', consumed_order_id = p_order_id, updated_at = clock_timestamp()
    WHERE reservation_id = p_reservation_id RETURNING * INTO reservation;
    RETURN reservation;
END;
$$;

CREATE TRIGGER seckill_governance_transitions_no_mutation
    BEFORE UPDATE OR DELETE ON core.seckill_governance_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER seckill_governance_actions_no_delete
    BEFORE DELETE ON core.seckill_governance_actions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER seckill_session_plans_no_delete
    BEFORE DELETE ON core.seckill_session_plans
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER seckill_prize_injections_no_delete
    BEFORE DELETE ON core.seckill_prize_injections
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
