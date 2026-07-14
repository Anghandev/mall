CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE core.auth_nonces (
    wallet_address text PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
    domain text NOT NULL,
    uri text NOT NULL,
    chain_id bigint NOT NULL CHECK (chain_id = 56),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.wallet_role_bindings (
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    role text NOT NULL CHECK (role IN ('BUYER', 'MERCHANT', 'ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR')),
    merchant_id text,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    PRIMARY KEY (wallet_address, role)
);

CREATE TABLE core.auth_sessions (
    session_id text PRIMARY KEY,
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
    roles jsonb NOT NULL CHECK (jsonb_typeof(roles) = 'array'),
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
    revoked_at timestamptz,
    last_seen_at timestamptz NOT NULL
);

CREATE TABLE core.policy_snapshots (
    policy_version bigint PRIMARY KEY CHECK (policy_version > 0),
    artifact_version text NOT NULL,
    policy_hash text NOT NULL UNIQUE CHECK (policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
    oracle_version text NOT NULL CHECK (oracle_version ~ '^0x[0-9a-fA-F]{64}$'),
    rules_content_hash text NOT NULL CHECK (rules_content_hash ~ '^0x[0-9a-fA-F]{64}$'),
    beneficiary_set_hash text NOT NULL CHECK (beneficiary_set_hash ~ '^0x[0-9a-fA-F]{64}$'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    publication_status text NOT NULL CHECK (publication_status = 'PUBLISHED'),
    safe_tx_hash text,
    effective_from timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.policy_drafts (
    draft_id text PRIMARY KEY,
    next_policy_version bigint NOT NULL CHECK (next_policy_version > 0),
    base_policy_version bigint REFERENCES core.policy_snapshots(policy_version),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(validation_errors) = 'array'),
    state text NOT NULL CHECK (state IN ('DRAFT', 'DECISION_BLOCKED', 'SECONDARY_SIGNED', 'SAFE_PROPOSED', 'REJECTED', 'PUBLISHED')),
    secondary_signature_hash text,
    safe_proposal_hash text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (next_policy_version, state)
);

CREATE TABLE core.merchants (
    merchant_id text PRIMARY KEY,
    settlement_wallet text NOT NULL UNIQUE CHECK (settlement_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'BLACKLISTED')),
    level text NOT NULL CHECK (level IN ('V1', 'V2', 'V3', 'V4', 'V5')),
    profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
    guarantee_status text NOT NULL CHECK (guarantee_status IN ('DECISION_BLOCKED', 'BELOW_MINIMUM', 'READY', 'FROZEN')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.products (
    product_id text PRIMARY KEY,
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    version bigint NOT NULL CHECK (version > 0),
    title text NOT NULL,
    lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('DRAFT', 'REVIEW', 'ACTIVE', 'HIDDEN', 'DELISTED', 'LOCKED')),
    product_policy_hash text NOT NULL CHECK (product_policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
    metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
    allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_actions) = 'array'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.skus (
    sku_id text PRIMARY KEY,
    product_id text NOT NULL REFERENCES core.products(product_id),
    sku_version bigint NOT NULL CHECK (sku_version > 0),
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
    merchant_cost_usdt numeric(78, 0) CHECK (merchant_cost_usdt IS NULL OR merchant_cost_usdt >= 0),
    stock_total bigint NOT NULL CHECK (stock_total >= 0),
    stock_available bigint NOT NULL CHECK (stock_available >= 0),
    stock_reserved bigint NOT NULL DEFAULT 0 CHECK (stock_reserved >= 0),
    lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('ACTIVE', 'LOCKED', 'DELISTED')),
    CHECK (stock_available + stock_reserved <= stock_total)
);

CREATE TABLE core.inventory_reservations (
    reservation_id text PRIMARY KEY,
    reservation_hash text NOT NULL UNIQUE CHECK (reservation_hash ~ '^0x[0-9a-fA-F]{64}$'),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    sku_id text NOT NULL REFERENCES core.skus(sku_id),
    buyer_wallet text NOT NULL CHECK (buyer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    quantity bigint NOT NULL CHECK (quantity > 0),
    classification text NOT NULL CHECK (classification IN ('ORDINARY', 'SECKILL', 'FALLBACK_RETAIL')),
    state text NOT NULL CHECK (state IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED')),
    expires_at timestamptz NOT NULL,
    consumed_order_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX inventory_reservations_active_idx
    ON core.inventory_reservations (sku_id, expires_at)
    WHERE state = 'ACTIVE';

CREATE TABLE core.seckill_sessions (
    session_id text PRIMARY KEY,
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    product_id text NOT NULL REFERENCES core.products(product_id),
    sku_id text NOT NULL REFERENCES core.skus(sku_id),
    product_policy_hash text NOT NULL CHECK (product_policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
    starts_at timestamptz NOT NULL,
    main_deadline timestamptz NOT NULL,
    relay_deadline timestamptz NOT NULL,
    inventory bigint NOT NULL CHECK (inventory > 0),
    sold bigint NOT NULL DEFAULT 0 CHECK (sold >= 0 AND sold <= inventory),
    phase text NOT NULL CHECK (phase IN ('PREHEAT', 'LIVE', 'SETTLING', 'SETTLED', 'FORCE_CLOSED')),
    last_buyer_wallet text,
    prize_pool_usdt numeric(78, 0) NOT NULL DEFAULT 0 CHECK (prize_pool_usdt >= 0),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_actions) = 'array'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (main_deadline > starts_at),
    CHECK (relay_deadline <= main_deadline)
);

CREATE TABLE core.orders (
    order_id text PRIMARY KEY,
    artifact_version text NOT NULL,
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    oracle_version text NOT NULL CHECK (oracle_version ~ '^0x[0-9a-fA-F]{64}$'),
    buyer_wallet text NOT NULL CHECK (buyer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    merchant_wallet text NOT NULL CHECK (merchant_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    product_id text NOT NULL REFERENCES core.products(product_id),
    sku_id text NOT NULL REFERENCES core.skus(sku_id),
    quantity bigint NOT NULL CHECK (quantity > 0),
    fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('DELIVERY', 'PICKUP')),
    fulfillment_target_hash text NOT NULL CHECK (fulfillment_target_hash ~ '^0x[0-9a-fA-F]{64}$'),
    encrypted_delivery_target bytea,
    region_code_hash text NOT NULL CHECK (region_code_hash ~ '^0x[0-9a-fA-F]{64}$'),
    product_policy_hash text NOT NULL CHECK (product_policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
    reservation_id text NOT NULL UNIQUE REFERENCES core.inventory_reservations(reservation_id),
    quote_snapshot jsonb NOT NULL CHECK (jsonb_typeof(quote_snapshot) = 'object'),
    allocation_snapshot jsonb NOT NULL CHECK (jsonb_typeof(allocation_snapshot) = 'object'),
    seckill_snapshot jsonb CHECK (seckill_snapshot IS NULL OR jsonb_typeof(seckill_snapshot) = 'object'),
    exact_amounts jsonb NOT NULL CHECK (jsonb_typeof(exact_amounts) = 'object'),
    buyer_nonce numeric(78, 0) NOT NULL CHECK (buyer_nonce >= 0),
    quote_deadline timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('QUOTED', 'SUBMITTED', 'PAID', 'SHIPPED', 'DELIVERED', 'ARBITRATION', 'TAKEOVER', 'FULFILLMENT_PENDING', 'FULFILLED', 'REORG_PENDING')),
    finality_status text NOT NULL CHECK (finality_status IN ('NOT_SUBMITTED', 'PENDING', 'CONFIRMED', 'REPLACED', 'REORGED', 'FINAL')),
    payment_tx_hash text,
    payment_block_hash text,
    paid_at timestamptz,
    fulfilled_at timestamptz,
    allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_actions) = 'array'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX orders_buyer_created_idx ON core.orders (buyer_wallet, created_at DESC);
CREATE INDEX orders_merchant_state_idx ON core.orders (merchant_id, state, created_at DESC);

CREATE TABLE core.fulfillment_evidence (
    evidence_id text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    evidence_type text NOT NULL CHECK (evidence_type IN ('SHIPMENT', 'DELIVERY', 'PICKUP_SCAN', 'FORCED_RECEIPT_REQUEST', 'FORCED_RECEIPT_REVIEW', 'ARBITRATION', 'TAKEOVER', 'RECONCILIATION')),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
    source text NOT NULL,
    provider_reference_hash text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    recorded_by text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (order_id, evidence_type, evidence_hash)
);

CREATE TABLE core.takeover_cases (
    case_id text PRIMARY KEY,
    order_id text NOT NULL UNIQUE REFERENCES core.orders(order_id),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    state text NOT NULL CHECK (state IN ('OPEN', 'FUNDED', 'FULFILLING', 'FULFILLMENT_PENDING', 'CLOSED', 'DECISION_BLOCKED')),
    required_usdt numeric(78, 0) NOT NULL CHECK (required_usdt > 0),
    guarantee_used_usdt numeric(78, 0) NOT NULL DEFAULT 0 CHECK (guarantee_used_usdt >= 0),
    merchant_available_used_usdt numeric(78, 0) NOT NULL DEFAULT 0 CHECK (merchant_available_used_usdt >= 0),
    risk_reserve_used_usdt numeric(78, 0) NOT NULL DEFAULT 0 CHECK (risk_reserve_used_usdt >= 0),
    disbursed_usdt numeric(78, 0) NOT NULL DEFAULT 0 CHECK (disbursed_usdt >= 0),
    merchant_debt_usdt numeric(78, 0) NOT NULL DEFAULT 0 CHECK (merchant_debt_usdt >= 0),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
    allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_actions) = 'array'),
    opened_at timestamptz NOT NULL,
    closed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (guarantee_used_usdt + merchant_available_used_usdt + risk_reserve_used_usdt = required_usdt),
    CHECK (disbursed_usdt <= required_usdt)
);

CREATE TABLE core.transaction_finality (
    transaction_id text PRIMARY KEY,
    resource_type text NOT NULL CHECK (resource_type IN ('ORDER_PAYMENT', 'FULFILLMENT', 'CLAIM', 'SECKILL_SETTLEMENT', 'POLICY', 'TAKEOVER_DISBURSEMENT', 'RECOVERY')),
    resource_id text NOT NULL,
    chain_id bigint NOT NULL CHECK (chain_id = 56),
    contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
    expected_event_hash text NOT NULL CHECK (expected_event_hash ~ '^0x[0-9a-fA-F]{64}$'),
    tx_hash text NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    replacement_for_tx_hash text,
    block_number bigint,
    block_hash text,
    confirmations bigint NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    receipt_status smallint CHECK (receipt_status IN (0, 1)),
    state text NOT NULL CHECK (state IN ('SUBMITTED', 'MINED', 'REPLACED', 'REORGED', 'FINAL', 'FAILED')),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
    submitted_at timestamptz NOT NULL,
    finalized_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX transaction_finality_resource_idx ON core.transaction_finality (resource_type, resource_id, updated_at DESC);

CREATE TABLE core.claim_projections (
    claim_id text PRIMARY KEY,
    resource_id text NOT NULL,
    claimant_wallet text NOT NULL CHECK (claimant_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    rail text NOT NULL CHECK (rail IN ('MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT', 'BNM')),
    asset_address text NOT NULL CHECK (asset_address ~ '^0x[0-9a-fA-F]{40}$'),
    cumulative_amount numeric(78, 0) NOT NULL CHECK (cumulative_amount >= 0),
    locked_amount numeric(78, 0) NOT NULL CHECK (locked_amount >= 0),
    available_amount numeric(78, 0) NOT NULL CHECK (available_amount >= 0),
    claimed_amount numeric(78, 0) NOT NULL CHECK (claimed_amount >= 0),
    state text NOT NULL CHECK (state IN ('LOCKED', 'PENDING_SETTLEMENT', 'AVAILABLE', 'CLAIM_SUBMITTED', 'CLAIMED', 'PAUSED', 'FROZEN')),
    allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_actions) = 'array'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (locked_amount + available_amount + claimed_amount = cumulative_amount)
);

CREATE TABLE core.circuit_breakers (
    scope text PRIMARY KEY CHECK (scope IN ('NEW_ORDERS', 'SECKILL_PURCHASE', 'SECKILL_SETTLEMENT', 'MERCHANT_CLAIM', 'REWARD_CLAIM', 'PRIZE_CLAIM')),
    paused boolean NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
    policy_version bigint REFERENCES core.policy_snapshots(policy_version),
    changed_by text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.idempotency_keys (
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_status integer,
    response_body jsonb,
    state text NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
    locked_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE core.outbox_events (
    event_id text PRIMARY KEY,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    idempotency_key text NOT NULL UNIQUE,
    state text NOT NULL CHECK (state IN ('PENDING', 'PROCESSING', 'DELIVERED', 'DEAD_LETTER')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    locked_by text,
    locked_until timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at timestamptz
);

CREATE INDEX outbox_ready_idx ON core.outbox_events (available_at, created_at) WHERE state = 'PENDING';

CREATE TABLE core.durable_jobs (
    job_id text PRIMARY KEY,
    job_type text NOT NULL CHECK (job_type IN ('INDEX_BLOCK', 'SYNC_FINALITY', 'OPEN_TAKEOVER', 'FORCED_RECEIPT_ELIGIBILITY', 'EXECUTE_INTENT', 'SEND_NOTIFICATION', 'LOGISTICS_WEBHOOK', 'PRINT_JOB', 'RECONCILE')),
    resource_id text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    idempotency_key text NOT NULL UNIQUE,
    state text NOT NULL CHECK (state IN ('READY', 'LEASED', 'SUCCEEDED', 'RETRY', 'DEAD_LETTER', 'CONFIGURATION_REQUIRED')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_owner text,
    lease_expires_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX durable_jobs_ready_idx ON core.durable_jobs (available_at, created_at) WHERE state IN ('READY', 'RETRY');

CREATE TABLE core.provider_readiness (
    provider text PRIMARY KEY CHECK (provider IN ('AMAP', 'KUAIDI100', 'FEIE', 'ALIYUN_SMS', 'ALIYUN_OSS', 'SMTP', 'JPUSH', 'RPC_PRIMARY', 'RPC_FALLBACK', 'EXPLORER')),
    secret_reference text,
    state text NOT NULL CHECK (state IN ('CONFIGURATION_REQUIRED', 'READY', 'DEGRADED', 'UNAVAILABLE')),
    checked_at timestamptz,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE TABLE core.indexer_checkpoints (
    worker_name text PRIMARY KEY,
    chain_id bigint NOT NULL CHECK (chain_id = 56),
    finalized_block bigint NOT NULL CHECK (finalized_block >= 0),
    finalized_block_hash text NOT NULL CHECK (finalized_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    observed_head bigint NOT NULL CHECK (observed_head >= finalized_block),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION core.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
END;
$$;

CREATE FUNCTION core.protect_order_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.artifact_version IS DISTINCT FROM OLD.artifact_version
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.oracle_version IS DISTINCT FROM OLD.oracle_version
        OR NEW.buyer_wallet IS DISTINCT FROM OLD.buyer_wallet
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.merchant_wallet IS DISTINCT FROM OLD.merchant_wallet
        OR NEW.product_id IS DISTINCT FROM OLD.product_id
        OR NEW.sku_id IS DISTINCT FROM OLD.sku_id
        OR NEW.quantity IS DISTINCT FROM OLD.quantity
        OR NEW.fulfillment_mode IS DISTINCT FROM OLD.fulfillment_mode
        OR NEW.fulfillment_target_hash IS DISTINCT FROM OLD.fulfillment_target_hash
        OR NEW.encrypted_delivery_target IS DISTINCT FROM OLD.encrypted_delivery_target
        OR NEW.region_code_hash IS DISTINCT FROM OLD.region_code_hash
        OR NEW.product_policy_hash IS DISTINCT FROM OLD.product_policy_hash
        OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
        OR NEW.quote_snapshot IS DISTINCT FROM OLD.quote_snapshot
        OR NEW.allocation_snapshot IS DISTINCT FROM OLD.allocation_snapshot
        OR NEW.seckill_snapshot IS DISTINCT FROM OLD.seckill_snapshot
        OR NEW.exact_amounts IS DISTINCT FROM OLD.exact_amounts
        OR NEW.buyer_nonce IS DISTINCT FROM OLD.buyer_nonce
        OR NEW.quote_deadline IS DISTINCT FROM OLD.quote_deadline
    THEN
        RAISE EXCEPTION 'ImmutableOrderSnapshot' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION core.protect_approved_settlement_wallet() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'APPROVED' AND NEW.settlement_wallet IS DISTINCT FROM OLD.settlement_wallet THEN
        RAISE EXCEPTION 'GovernedWalletMigrationRequired' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER policy_snapshots_immutable
    BEFORE UPDATE OR DELETE ON core.policy_snapshots
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER orders_snapshot_immutable
    BEFORE UPDATE ON core.orders
    FOR EACH ROW EXECUTE FUNCTION core.protect_order_snapshot();

CREATE TRIGGER orders_no_delete
    BEFORE DELETE ON core.orders
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER merchants_settlement_wallet_governed
    BEFORE UPDATE ON core.merchants
    FOR EACH ROW EXECUTE FUNCTION core.protect_approved_settlement_wallet();

CREATE TRIGGER products_no_delete
    BEFORE DELETE ON core.products
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER skus_no_delete
    BEFORE DELETE ON core.skus
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER reservations_no_delete
    BEFORE DELETE ON core.inventory_reservations
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER seckill_sessions_no_delete
    BEFORE DELETE ON core.seckill_sessions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER fulfillment_evidence_no_mutation
    BEFORE UPDATE OR DELETE ON core.fulfillment_evidence
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER transaction_finality_no_delete
    BEFORE DELETE ON core.transaction_finality
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER takeover_cases_no_delete
    BEFORE DELETE ON core.takeover_cases
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER claim_projections_no_delete
    BEFORE DELETE ON core.claim_projections
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER outbox_no_delete
    BEFORE DELETE ON core.outbox_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER durable_jobs_no_delete
    BEFORE DELETE ON core.durable_jobs
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
