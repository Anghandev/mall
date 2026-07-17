CREATE TABLE core.buyer_profiles (
    buyer_wallet text PRIMARY KEY CHECK (buyer_wallet ~ '^0x[0-9a-f]{40}$'),
    encrypted_nickname bytea,
    encryption_iv bytea,
    encryption_tag bytea,
    avatar_asset_id text REFERENCES core.media_assets(asset_id),
    retention_policy_version text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (
        (encrypted_nickname IS NULL AND encryption_iv IS NULL AND encryption_tag IS NULL)
        OR (encrypted_nickname IS NOT NULL AND octet_length(encrypted_nickname) > 0
            AND octet_length(encryption_iv) = 12 AND octet_length(encryption_tag) = 16)
    ),
    CHECK ((encrypted_nickname IS NULL) = (retention_policy_version IS NULL))
);

CREATE TABLE core.buyer_saved_addresses (
    address_id text PRIMARY KEY,
    buyer_wallet text NOT NULL CHECK (buyer_wallet ~ '^0x[0-9a-f]{40}$'),
    encrypted_payload bytea NOT NULL CHECK (octet_length(encrypted_payload) > 0),
    encryption_iv bytea NOT NULL CHECK (octet_length(encryption_iv) = 12),
    encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
    retention_policy_version text NOT NULL,
    is_default boolean NOT NULL DEFAULT false,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'DELETED')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
);

CREATE UNIQUE INDEX buyer_saved_addresses_one_default_idx
    ON core.buyer_saved_addresses (buyer_wallet)
    WHERE status = 'ACTIVE' AND is_default;
CREATE INDEX buyer_saved_addresses_wallet_idx
    ON core.buyer_saved_addresses (buyer_wallet, status, updated_at DESC, address_id);

CREATE TABLE core.buyer_account_locks (
    buyer_wallet text PRIMARY KEY CHECK (buyer_wallet ~ '^0x[0-9a-f]{40}$'),
    updated_at timestamptz NOT NULL
);

CREATE TABLE core.account_write_commands (
    command_id text PRIMARY KEY CHECK (command_id ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    merchant_id text REFERENCES core.merchants(merchant_id),
    command_type text NOT NULL CHECK (command_type IN (
        'BUYER_PROFILE_UPDATE', 'BUYER_ADDRESS_CREATE', 'BUYER_ADDRESS_UPDATE',
        'BUYER_ADDRESS_DELETE', 'BUYER_ADDRESS_SET_DEFAULT', 'MERCHANT_PROFILE_UPDATE',
        'MERCHANT_AUDIT_EXPORT'
    )),
    resource_id text NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key)
);

CREATE TRIGGER account_write_commands_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.account_write_commands
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

ALTER TABLE core.merchants
    ADD COLUMN profile_version bigint NOT NULL DEFAULT 1 CHECK (profile_version > 0);

ALTER TABLE core.settlement_intents
    ADD COLUMN merchant_id text REFERENCES core.merchants(merchant_id);
ALTER TABLE core.settlement_requests
    ADD COLUMN merchant_id text REFERENCES core.merchants(merchant_id);

UPDATE core.settlement_intents intent
SET merchant_id = scoped.merchant_id
FROM (
    SELECT item.intent_id, min(orders.merchant_id) AS merchant_id
    FROM core.settlement_intent_items item
    JOIN core.orders orders ON orders.order_id = item.order_id
    GROUP BY item.intent_id
    HAVING count(DISTINCT orders.merchant_id) = 1
) scoped
WHERE scoped.intent_id = intent.intent_id
  AND intent.rail IN ('MERCHANT_USDT', 'TAKEOVER_USDT', 'OPERATIONS_REIMBURSEMENT_USDT');

UPDATE core.settlement_requests request
SET merchant_id = intent.merchant_id
FROM core.settlement_intents intent
WHERE intent.intent_id = request.intent_id;

CREATE INDEX settlement_intents_merchant_idx
    ON core.settlement_intents (merchant_id, created_at DESC)
    WHERE merchant_id IS NOT NULL;
CREATE INDEX settlement_requests_merchant_idx
    ON core.settlement_requests (merchant_id, requested_at DESC)
    WHERE merchant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION core.protect_approved_settlement_wallet() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.settlement_wallet IS DISTINCT FROM OLD.settlement_wallet THEN
        RAISE EXCEPTION 'ImmutableSettlementWallet' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE core.media_upload_intents
    DROP CONSTRAINT media_upload_intents_purpose_check,
    DROP CONSTRAINT media_upload_intents_resource_type_check,
    DROP CONSTRAINT media_upload_intents_check1,
    DROP CONSTRAINT media_upload_intents_check2,
    ADD CONSTRAINT media_upload_intents_purpose_check CHECK (purpose IN (
        'PRODUCT_IMAGE', 'PRODUCT_VIDEO', 'CATEGORY_ICON', 'STORE_IMAGE',
        'FULFILLMENT_EVIDENCE', 'BUYER_AVATAR', 'MERCHANT_LOGO'
    )),
    ADD CONSTRAINT media_upload_intents_resource_type_check CHECK (resource_type IN (
        'PRODUCT', 'CATEGORY', 'STORE', 'ORDER', 'BUYER', 'MERCHANT'
    )),
    ADD CONSTRAINT media_upload_intents_resource_match_check CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'PRODUCT_VIDEO') AND resource_type = 'PRODUCT')
        OR (purpose = 'CATEGORY_ICON' AND resource_type = 'CATEGORY')
        OR (purpose = 'STORE_IMAGE' AND resource_type = 'STORE')
        OR (purpose = 'FULFILLMENT_EVIDENCE' AND resource_type = 'ORDER')
        OR (purpose = 'BUYER_AVATAR' AND resource_type = 'BUYER')
        OR (purpose = 'MERCHANT_LOGO' AND resource_type = 'MERCHANT')
    ),
    ADD CONSTRAINT media_upload_intents_content_match_check CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'CATEGORY_ICON', 'STORE_IMAGE', 'BUYER_AVATAR', 'MERCHANT_LOGO')
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp'))
        OR (purpose = 'PRODUCT_VIDEO' AND content_type = 'video/mp4')
        OR (purpose = 'FULFILLMENT_EVIDENCE'
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
    );

ALTER TABLE core.media_assets
    DROP CONSTRAINT media_assets_purpose_check,
    DROP CONSTRAINT media_assets_resource_type_check,
    DROP CONSTRAINT media_assets_check,
    DROP CONSTRAINT media_assets_check1,
    ADD CONSTRAINT media_assets_purpose_check CHECK (purpose IN (
        'PRODUCT_IMAGE', 'PRODUCT_VIDEO', 'CATEGORY_ICON', 'STORE_IMAGE',
        'FULFILLMENT_EVIDENCE', 'BUYER_AVATAR', 'MERCHANT_LOGO'
    )),
    ADD CONSTRAINT media_assets_resource_type_check CHECK (resource_type IN (
        'PRODUCT', 'CATEGORY', 'STORE', 'ORDER', 'BUYER', 'MERCHANT'
    )),
    ADD CONSTRAINT media_assets_resource_match_check CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'PRODUCT_VIDEO') AND resource_type = 'PRODUCT')
        OR (purpose = 'CATEGORY_ICON' AND resource_type = 'CATEGORY')
        OR (purpose = 'STORE_IMAGE' AND resource_type = 'STORE')
        OR (purpose = 'FULFILLMENT_EVIDENCE' AND resource_type = 'ORDER')
        OR (purpose = 'BUYER_AVATAR' AND resource_type = 'BUYER')
        OR (purpose = 'MERCHANT_LOGO' AND resource_type = 'MERCHANT')
    ),
    ADD CONSTRAINT media_assets_content_match_check CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'CATEGORY_ICON', 'STORE_IMAGE', 'BUYER_AVATAR', 'MERCHANT_LOGO')
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp'))
        OR (purpose = 'PRODUCT_VIDEO' AND content_type = 'video/mp4')
        OR (purpose = 'FULFILLMENT_EVIDENCE'
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
    );

ALTER TABLE core.audit_outbox_events
    ADD COLUMN merchant_id text REFERENCES core.merchants(merchant_id);

CREATE INDEX audit_outbox_merchant_idx
    ON core.audit_outbox_events (merchant_id, created_at DESC, source_event_id)
    WHERE merchant_id IS NOT NULL;

CREATE TABLE core.takeover_case_transitions (
    transition_id text PRIMARY KEY,
    case_id text NOT NULL REFERENCES core.takeover_cases(case_id),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    from_state text CHECK (from_state IS NULL OR from_state IN (
        'OPEN', 'FUNDED', 'FULFILLING', 'FULFILLMENT_PENDING', 'CLOSED', 'DECISION_BLOCKED'
    )),
    to_state text NOT NULL CHECK (to_state IN (
        'OPEN', 'FUNDED', 'FULFILLING', 'FULFILLMENT_PENDING', 'CLOSED', 'DECISION_BLOCKED'
    )),
    public_evidence_type text NOT NULL CHECK (length(public_evidence_type) BETWEEN 1 AND 64),
    public_evidence_hash text NOT NULL CHECK (public_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (case_id, to_state, public_evidence_hash)
);

CREATE INDEX takeover_case_transitions_order_idx
    ON core.takeover_case_transitions (order_id, occurred_at, transition_id);
CREATE TRIGGER takeover_case_transitions_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.takeover_case_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

INSERT INTO core.takeover_case_transitions (
    transition_id, case_id, order_id, from_state, to_state,
    public_evidence_type, public_evidence_hash, occurred_at
)
SELECT 'takeover-transition:legacy-open:' || case_id, case_id, order_id, NULL, 'OPEN',
       'LEGACY_OPEN_EVIDENCE', evidence_hash, opened_at
FROM core.takeover_cases
ON CONFLICT (case_id, to_state, public_evidence_hash) DO NOTHING;
