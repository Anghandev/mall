CREATE TABLE core.ledger_accounts (
    account_id text PRIMARY KEY,
    owner_type text NOT NULL CHECK (owner_type IN ('SYSTEM', 'SAFE', 'MERCHANT', 'BUYER', 'BENEFICIARY')),
    owner_id text NOT NULL,
    asset text NOT NULL CHECK (asset IN ('USDT', 'NPL', 'BNM_POINTS')),
    purpose text NOT NULL CHECK (purpose IN (
        'SAFE_ASSET', 'PAYMENT_CLEARING', 'BURN', 'MERCHANT_RECEIVABLE',
        'CONCESSION', 'POLICY_ALLOCATION', 'REWARD_LIABILITY',
        'BNM_ISSUANCE', 'BNM_LIABILITY'
    )),
    safe_address text CHECK (safe_address IS NULL OR safe_address ~ '^0x[0-9a-fA-F]{40}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (owner_type, owner_id, asset, purpose)
);

CREATE TABLE core.ledger_journals (
    journal_id text PRIMARY KEY,
    event_key text NOT NULL UNIQUE,
    event_type text NOT NULL CHECK (event_type IN ('PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL')),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    content_hash text NOT NULL CHECK (content_hash ~ '^0x[0-9a-fA-F]{64}$'),
    source_tx_hash text NOT NULL CHECK (source_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    source_block_hash text NOT NULL CHECK (source_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    reversal_of text REFERENCES core.ledger_journals(journal_id),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((event_type = 'PAYMENT_REORG_REVERSAL') = (reversal_of IS NOT NULL))
);

CREATE TABLE core.ledger_lines (
    line_id bigserial PRIMARY KEY,
    journal_id text NOT NULL REFERENCES core.ledger_journals(journal_id),
    account_id text NOT NULL REFERENCES core.ledger_accounts(account_id),
    side text NOT NULL CHECK (side IN ('DEBIT', 'CREDIT')),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    balance_state text NOT NULL CHECK (balance_state IN (
        'POSTED', 'LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED', 'DISPUTED'
    )),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (journal_id, account_id, side, balance_state)
);

CREATE INDEX ledger_lines_account_idx ON core.ledger_lines (account_id, created_at, line_id);
CREATE INDEX ledger_journals_order_idx ON core.ledger_journals (order_id, created_at);

CREATE TABLE core.payment_events (
    event_key text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    journal_id text NOT NULL UNIQUE REFERENCES core.ledger_journals(journal_id),
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
    log_index bigint NOT NULL CHECK (log_index >= 0),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^0x[0-9a-fA-F]{64}$'),
    classification text NOT NULL CHECK (classification IN ('ORDINARY', 'SECKILL', 'FALLBACK_RETAIL')),
    confirmations bigint NOT NULL CHECK (confirmations >= 0),
    canonical boolean NOT NULL DEFAULT true,
    replacement_block_hash text,
    observed_at timestamptz NOT NULL,
    replaced_at timestamptz,
    UNIQUE (transaction_hash, log_index, block_hash)
);

CREATE UNIQUE INDEX payment_events_canonical_order_idx
    ON core.payment_events (order_id)
    WHERE canonical;

CREATE TABLE core.payment_quotes (
    order_id text PRIMARY KEY CHECK (order_id ~ '^0x[0-9a-fA-F]{64}$'),
    idempotency_key text NOT NULL,
    artifact_version text NOT NULL,
    buyer_wallet text NOT NULL CHECK (buyer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    merchant_wallet text NOT NULL CHECK (merchant_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    product_id text NOT NULL REFERENCES core.products(product_id),
    sku_id text NOT NULL REFERENCES core.skus(sku_id),
    chain_product_id text NOT NULL CHECK (chain_product_id ~ '^0x[0-9a-fA-F]{64}$'),
    chain_sku_id text NOT NULL CHECK (chain_sku_id ~ '^0x[0-9a-fA-F]{64}$'),
    product_policy_hash text NOT NULL CHECK (product_policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
    list_price_usdt numeric(78, 0) NOT NULL CHECK (list_price_usdt > 0),
    seckill_list_price_usdt numeric(78, 0) CHECK (seckill_list_price_usdt IS NULL OR seckill_list_price_usdt > 0),
    merchant_cost_usdt numeric(78, 0) NOT NULL CHECK (merchant_cost_usdt >= 0),
    merchant_concession_bps integer NOT NULL CHECK (merchant_concession_bps BETWEEN 0 AND 10000),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    quote_kind text NOT NULL CHECK (quote_kind IN ('ORDINARY', 'SECKILL')),
    session_id text CHECK (session_id IS NULL OR session_id ~ '^0x[0-9a-fA-F]{64}$'),
    authorization_digest text NOT NULL CHECK (authorization_digest ~ '^0x[0-9a-fA-F]{64}$'),
    quote_signature text NOT NULL CHECK (quote_signature ~ '^0x[0-9a-fA-F]+$'),
    deadline timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('QUOTED', 'SUBMITTED', 'PAID', 'REORGED', 'EXPIRED')),
    submitted_tx_hash text CHECK (submitted_tx_hash IS NULL OR submitted_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    submitted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((quote_kind = 'SECKILL') = (session_id IS NOT NULL)),
    CHECK ((quote_kind = 'SECKILL') = (seckill_list_price_usdt IS NOT NULL)),
    CHECK ((state IN ('SUBMITTED', 'PAID', 'REORGED')) = (submitted_tx_hash IS NOT NULL)),
    UNIQUE (buyer_wallet, idempotency_key)
);

CREATE TABLE core.payment_quote_legs (
    order_id text NOT NULL REFERENCES core.payment_quotes(order_id),
    classification text NOT NULL CHECK (classification IN ('ORDINARY', 'SECKILL', 'FALLBACK_RETAIL')),
    reservation_id text NOT NULL UNIQUE REFERENCES core.inventory_reservations(reservation_id),
    snapshot_hash text NOT NULL UNIQUE CHECK (snapshot_hash ~ '^0x[0-9a-fA-F]{64}$'),
    intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (order_id, classification),
    CHECK ((classification = 'SECKILL') = ((intent ->> 'seckill')::boolean))
);

CREATE INDEX payment_quote_legs_snapshot_idx ON core.payment_quote_legs (snapshot_hash, order_id);

CREATE FUNCTION core.protect_payment_quote_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.buyer_wallet IS DISTINCT FROM OLD.buyer_wallet
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.merchant_wallet IS DISTINCT FROM OLD.merchant_wallet
        OR NEW.product_id IS DISTINCT FROM OLD.product_id
        OR NEW.sku_id IS DISTINCT FROM OLD.sku_id
        OR NEW.chain_product_id IS DISTINCT FROM OLD.chain_product_id
        OR NEW.chain_sku_id IS DISTINCT FROM OLD.chain_sku_id
        OR NEW.product_policy_hash IS DISTINCT FROM OLD.product_policy_hash
        OR NEW.list_price_usdt IS DISTINCT FROM OLD.list_price_usdt
        OR NEW.seckill_list_price_usdt IS DISTINCT FROM OLD.seckill_list_price_usdt
        OR NEW.merchant_cost_usdt IS DISTINCT FROM OLD.merchant_cost_usdt
        OR NEW.merchant_concession_bps IS DISTINCT FROM OLD.merchant_concession_bps
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.quote_kind IS DISTINCT FROM OLD.quote_kind
        OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest
        OR NEW.quote_signature IS DISTINCT FROM OLD.quote_signature
        OR NEW.deadline IS DISTINCT FROM OLD.deadline
    THEN
        RAISE EXCEPTION 'ImmutablePaymentQuoteSnapshot' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION core.post_balanced_journal(
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
DECLARE
    existing core.ledger_journals;
BEGIN
    SELECT * INTO existing FROM core.ledger_journals WHERE event_key = p_event_key;
    IF FOUND THEN
        IF existing.content_hash <> p_content_hash OR existing.order_id <> p_order_id THEN
            RAISE EXCEPTION 'LedgerIdempotencyConflict' USING ERRCODE = 'P0001';
        END IF;
        RETURN existing.journal_id;
    END IF;

    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
        RAISE EXCEPTION 'InvalidLedgerLines' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_lines) AS line(account_id text, side text, amount numeric, balance_state text)
        LEFT JOIN core.ledger_accounts account ON account.account_id = line.account_id
        WHERE account.account_id IS NULL OR line.side NOT IN ('DEBIT', 'CREDIT') OR line.amount <= 0
            OR line.balance_state NOT IN ('POSTED', 'LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED', 'DISPUTED')
    ) THEN
        RAISE EXCEPTION 'InvalidLedgerLines' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_lines) AS line(account_id text, side text, amount numeric, balance_state text)
        JOIN core.ledger_accounts account ON account.account_id = line.account_id
        GROUP BY account.asset
        HAVING sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE 0 END)
            <> sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE 0 END)
    ) THEN
        RAISE EXCEPTION 'UnbalancedLedgerJournal' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO core.ledger_journals (
        journal_id, event_key, event_type, order_id, policy_version, content_hash,
        source_tx_hash, source_block_hash, reversal_of, payload
    ) VALUES (
        p_journal_id, p_event_key, p_event_type, p_order_id, p_policy_version,
        p_content_hash, p_source_tx_hash, p_source_block_hash, p_reversal_of, p_payload
    );
    INSERT INTO core.ledger_lines (journal_id, account_id, side, amount, balance_state)
    SELECT p_journal_id, line.account_id, line.side, line.amount, line.balance_state
    FROM jsonb_to_recordset(p_lines) AS line(account_id text, side text, amount numeric, balance_state text);
    RETURN p_journal_id;
END;
$$;

CREATE FUNCTION core.consume_inventory_reservation_at(
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

CREATE FUNCTION core.restore_reorged_inventory_reservation(p_reservation_id text)
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

CREATE FUNCTION core.consume_reorged_inventory_reservation(
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

CREATE TRIGGER ledger_accounts_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER ledger_journals_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.ledger_journals
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER ledger_lines_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.ledger_lines
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER payment_events_no_delete
    BEFORE DELETE ON core.payment_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER payment_quote_legs_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.payment_quote_legs
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER payment_quotes_snapshot_immutable
    BEFORE UPDATE ON core.payment_quotes
    FOR EACH ROW EXECUTE FUNCTION core.protect_payment_quote_snapshot();
CREATE TRIGGER payment_quotes_no_delete
    BEFORE DELETE ON core.payment_quotes
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
