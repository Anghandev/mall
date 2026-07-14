ALTER TABLE core.orders
    ADD COLUMN shipped_at timestamptz,
    ADD COLUMN delivered_at timestamptz,
    ADD COLUMN takeover_opened_at timestamptz,
    ADD COLUMN arbitration_opened_at timestamptz,
    ADD COLUMN bnm_state_version bigint NOT NULL DEFAULT 0 CHECK (bnm_state_version >= 0);

ALTER TABLE core.ledger_accounts
    DROP CONSTRAINT ledger_accounts_purpose_check;

ALTER TABLE core.ledger_accounts
    ADD CONSTRAINT ledger_accounts_purpose_check CHECK (purpose IN (
        'SAFE_ASSET', 'PAYMENT_CLEARING', 'BURN', 'MERCHANT_RECEIVABLE',
        'CONCESSION', 'POLICY_ALLOCATION', 'SECKILL_PRIZE_LIABILITY',
        'REWARD_LIABILITY', 'BNM_ISSUANCE', 'BNM_LIABILITY'
    ));

CREATE TABLE core.administrative_regions (
    region_code text PRIMARY KEY CHECK (region_code ~ '^[0-9]{6}$'),
    province text NOT NULL,
    city text NOT NULL,
    district text NOT NULL,
    source text NOT NULL CHECK (source IN ('AMAP', 'GOVERNED_IMPORT')),
    source_reference_hash text NOT NULL CHECK (source_reference_hash ~ '^0x[0-9a-fA-F]{64}$'),
    status text NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.merchant_stores (
    store_id text PRIMARY KEY,
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-fA-F]{64}$'),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    region_code text NOT NULL REFERENCES core.administrative_regions(region_code),
    longitude numeric(10, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    latitude numeric(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    address text NOT NULL CHECK (length(address) BETWEEN 5 AND 300),
    phone text NOT NULL CHECK (phone ~ '^[+]?[0-9-]{7,20}$'),
    status text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
    version bigint NOT NULL CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (merchant_id, name, version),
    UNIQUE (merchant_id, idempotency_key)
);

CREATE TABLE core.fulfillment_targets (
    target_id text PRIMARY KEY,
    target_hash text NOT NULL UNIQUE CHECK (target_hash ~ '^0x[0-9a-fA-F]{64}$'),
    buyer_wallet text NOT NULL CHECK (buyer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-fA-F]{64}$'),
    fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('DELIVERY', 'PICKUP')),
    region_code text NOT NULL REFERENCES core.administrative_regions(region_code),
    region_code_hash text NOT NULL CHECK (region_code_hash ~ '^0x[0-9a-fA-F]{64}$'),
    store_id text REFERENCES core.merchant_stores(store_id),
    encrypted_payload bytea NOT NULL,
    encryption_iv bytea NOT NULL CHECK (octet_length(encryption_iv) = 12),
    encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (buyer_wallet, idempotency_key),
    CHECK ((fulfillment_mode = 'PICKUP') = (store_id IS NOT NULL)),
    CHECK (expires_at > created_at)
);

CREATE INDEX fulfillment_targets_active_idx
    ON core.fulfillment_targets (buyer_wallet, expires_at, target_hash);

CREATE TRIGGER administrative_regions_no_mutation
    BEFORE UPDATE OR DELETE ON core.administrative_regions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER fulfillment_targets_no_mutation
    BEFORE UPDATE OR DELETE ON core.fulfillment_targets
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER merchant_stores_no_delete
    BEFORE DELETE ON core.merchant_stores
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

ALTER TABLE core.fulfillment_evidence
    DROP CONSTRAINT fulfillment_evidence_evidence_type_check;

ALTER TABLE core.fulfillment_evidence
    ADD CONSTRAINT fulfillment_evidence_evidence_type_check CHECK (evidence_type IN (
        'SHIPMENT', 'LOGISTICS_UPDATE', 'DELIVERY', 'RECEIPT_CONFIRMATION',
        'PICKUP_CREDENTIAL', 'PICKUP_SCAN',
        'EXCHANGE_REQUEST', 'DELAY_REQUEST', 'REQUEST_DECISION', 'FORCED_RECEIPT_REQUEST',
        'FORCED_RECEIPT_REVIEW', 'ARBITRATION', 'ARBITRATION_DECISION',
        'TAKEOVER', 'RECONCILIATION'
    ));

ALTER TABLE core.ledger_journals
    DROP CONSTRAINT ledger_journals_event_type_check;

ALTER TABLE core.ledger_journals
    ADD CONSTRAINT ledger_journals_event_type_check CHECK (event_type IN (
        'PAYMENT_LOCKED', 'PAYMENT_REORG_REVERSAL',
        'ARBITRATION_DISPUTED', 'ARBITRATION_RESOLVED', 'FULFILLMENT_AVAILABLE'
    ));

ALTER TABLE core.takeover_cases
    DROP CONSTRAINT takeover_cases_check,
    DROP CONSTRAINT takeover_cases_required_usdt_check,
    DROP COLUMN risk_reserve_used_usdt,
    ALTER COLUMN required_usdt DROP NOT NULL;

ALTER TABLE core.takeover_cases
    ADD CONSTRAINT takeover_cases_funding_check CHECK (
        required_usdt IS NULL
        AND guarantee_used_usdt = 0
        AND merchant_available_used_usdt = 0
    );

CREATE TABLE core.fulfillment_commands (
    command_id text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    command_type text NOT NULL CHECK (command_type IN (
        'RECORD_SHIPMENT', 'RECORD_LOGISTICS_UPDATE', 'RECORD_DELIVERY', 'REGISTER_PICKUP_CREDENTIAL',
        'VERIFY_PICKUP', 'REQUEST_EXCHANGE', 'REQUEST_DELAY',
        'DECIDE_FULFILLMENT_REQUEST',
        'OPEN_ARBITRATION', 'DECIDE_ARBITRATION', 'OPEN_TAKEOVER',
        'REQUEST_FORCED_RECEIPT', 'DECIDE_FORCED_RECEIPT', 'CONFIRM_RECEIPT'
    )),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    content_hash text NOT NULL CHECK (content_hash ~ '^0x[0-9a-fA-F]{64}$'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (actor_wallet, idempotency_key)
);

CREATE TABLE core.shipments (
    shipment_id text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    command_id text NOT NULL UNIQUE REFERENCES core.fulfillment_commands(command_id),
    carrier_code text NOT NULL CHECK (carrier_code ~ '^[A-Z0-9_-]{2,32}$'),
    tracking_number_hash text NOT NULL CHECK (tracking_number_hash ~ '^0x[0-9a-fA-F]{64}$'),
    provider_reference_hash text CHECK (
        provider_reference_hash IS NULL OR provider_reference_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    evidence_id text NOT NULL UNIQUE REFERENCES core.fulfillment_evidence(evidence_id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (order_id, tracking_number_hash)
);

CREATE TABLE core.logistics_events (
    logistics_event_id text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    command_id text NOT NULL UNIQUE REFERENCES core.fulfillment_commands(command_id),
    provider text NOT NULL CHECK (provider IN ('KUAIDI100', 'CAINIAO')),
    provider_event_id_hash text NOT NULL CHECK (provider_event_id_hash ~ '^0x[0-9a-fA-F]{64}$'),
    status text NOT NULL CHECK (status IN (
        'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'
    )),
    location_hash text CHECK (location_hash IS NULL OR location_hash ~ '^0x[0-9a-fA-F]{64}$'),
    evidence_id text NOT NULL UNIQUE REFERENCES core.fulfillment_evidence(evidence_id),
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (provider, provider_event_id_hash)
);

CREATE INDEX logistics_events_order_idx
    ON core.logistics_events (order_id, occurred_at, logistics_event_id);

CREATE TRIGGER logistics_events_no_mutation
    BEFORE UPDATE OR DELETE ON core.logistics_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TABLE core.fulfillment_requests (
    request_id text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    command_id text NOT NULL UNIQUE REFERENCES core.fulfillment_commands(command_id),
    request_type text NOT NULL CHECK (request_type IN (
        'EXCHANGE', 'DELAY', 'ARBITRATION', 'FORCED_RECEIPT'
    )),
    state text NOT NULL CHECK (state IN ('OPEN', 'APPROVED', 'REJECTED', 'RESOLVED')),
    evidence_id text NOT NULL UNIQUE REFERENCES core.fulfillment_evidence(evidence_id),
    resolution_evidence_id text REFERENCES core.fulfillment_evidence(evidence_id),
    requested_by text NOT NULL CHECK (requested_by ~ '^0x[0-9a-fA-F]{40}$'),
    resolved_by text CHECK (resolved_by IS NULL OR resolved_by ~ '^0x[0-9a-fA-F]{40}$'),
    requested_at timestamptz NOT NULL,
    resolved_at timestamptz,
    CHECK ((resolved_at IS NULL) = (state = 'OPEN'))
);

CREATE UNIQUE INDEX fulfillment_requests_one_open_kind_idx
    ON core.fulfillment_requests (order_id, request_type)
    WHERE state = 'OPEN';

CREATE TABLE core.pickup_credentials (
    credential_id text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    command_id text NOT NULL UNIQUE REFERENCES core.fulfillment_commands(command_id),
    store_id text NOT NULL REFERENCES core.merchant_stores(store_id),
    code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{32}$'),
    evidence_id text NOT NULL UNIQUE REFERENCES core.fulfillment_evidence(evidence_id),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    invalidated_at timestamptz,
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
    last_failed_at timestamptz,
    created_at timestamptz NOT NULL,
    UNIQUE (order_id, code_hash),
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
    CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
    CHECK (last_failed_at IS NULL OR last_failed_at >= created_at),
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

CREATE UNIQUE INDEX pickup_credentials_one_active_idx
    ON core.pickup_credentials (order_id)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE core.pickup_verification_attempts (
    attempt_id text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    credential_id text REFERENCES core.pickup_credentials(credential_id),
    command_id text NOT NULL UNIQUE REFERENCES core.fulfillment_commands(command_id),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    store_id text NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
    successful boolean NOT NULL,
    error_code text CHECK ((successful AND error_code IS NULL) OR (NOT successful AND error_code IS NOT NULL)),
    attempted_at timestamptz NOT NULL
);

CREATE INDEX pickup_verification_attempts_order_idx
    ON core.pickup_verification_attempts (order_id, attempted_at, attempt_id);

CREATE TABLE core.fulfillment_transitions (
    transition_id text PRIMARY KEY,
    order_id text NOT NULL REFERENCES core.orders(order_id),
    command_id text NOT NULL UNIQUE REFERENCES core.fulfillment_commands(command_id),
    from_state text NOT NULL,
    to_state text NOT NULL,
    method text CHECK (method IS NULL OR method IN (
        'CUSTOMER_RECEIPT', 'PICKUP_VERIFICATION', 'FORCED_RECEIPT', 'ARBITRATION'
    )),
    evidence_id text NOT NULL UNIQUE REFERENCES core.fulfillment_evidence(evidence_id),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-fA-F]{40}$'),
    created_at timestamptz NOT NULL,
    CHECK (from_state <> to_state)
);

CREATE INDEX fulfillment_transitions_order_idx
    ON core.fulfillment_transitions (order_id, created_at, transition_id);

CREATE TABLE core.bnm_state_syncs (
    sync_id text PRIMARY KEY,
    event_id text NOT NULL UNIQUE REFERENCES core.outbox_events(event_id),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    amount numeric(78, 0) NOT NULL CHECK (amount > 0),
    source_evidence_hash text NOT NULL CHECK (source_evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
    provider_reference_hash text NOT NULL CHECK (provider_reference_hash ~ '^0x[0-9a-fA-F]{64}$'),
    state text NOT NULL CHECK (state IN ('LOCKED', 'AVAILABLE')),
    state_version bigint NOT NULL CHECK (state_version > 0),
    synced_at timestamptz NOT NULL,
    UNIQUE (order_id, state, source_evidence_hash),
    UNIQUE (order_id, state_version)
);

CREATE INDEX bnm_state_syncs_order_idx ON core.bnm_state_syncs (order_id, synced_at, sync_id);

CREATE TRIGGER bnm_state_syncs_no_mutation
    BEFORE UPDATE OR DELETE ON core.bnm_state_syncs
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

ALTER TABLE core.provider_readiness
    DROP CONSTRAINT provider_readiness_provider_check;

ALTER TABLE core.provider_readiness
    ADD CONSTRAINT provider_readiness_provider_check CHECK (provider IN (
        'AMAP', 'KUAIDI100', 'CAINIAO', 'FEIE', 'YILIANYUN', 'BNM',
        'ALIYUN_SMS', 'ALIYUN_OSS', 'SMTP', 'JPUSH',
        'RPC_PRIMARY', 'RPC_FALLBACK', 'EXPLORER'
    ));

CREATE TRIGGER fulfillment_commands_no_mutation
    BEFORE UPDATE OR DELETE ON core.fulfillment_commands
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER shipments_no_mutation
    BEFORE UPDATE OR DELETE ON core.shipments
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER fulfillment_transitions_no_mutation
    BEFORE UPDATE OR DELETE ON core.fulfillment_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER pickup_verification_attempts_no_mutation
    BEFORE UPDATE OR DELETE ON core.pickup_verification_attempts
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
