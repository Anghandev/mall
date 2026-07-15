CREATE TABLE core.media_upload_intents (
    upload_intent_id text PRIMARY KEY CHECK (upload_intent_id ~ '^0x[0-9a-f]{64}$'),
    owner_wallet text NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
    purpose text NOT NULL CHECK (purpose IN (
        'PRODUCT_IMAGE', 'PRODUCT_VIDEO', 'CATEGORY_ICON',
        'STORE_IMAGE', 'FULFILLMENT_EVIDENCE'
    )),
    resource_type text NOT NULL CHECK (resource_type IN ('PRODUCT', 'CATEGORY', 'STORE', 'ORDER')),
    resource_id text NOT NULL,
    object_key text NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 16 AND 512),
    content_type text NOT NULL CHECK (content_type IN (
        'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'
    )),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^0x[0-9a-f]{64}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('PENDING', 'UPLOADED', 'VERIFIED', 'REJECTED')),
    expires_at timestamptz NOT NULL,
    provider_reference_hash text CHECK (
        provider_reference_hash IS NULL OR provider_reference_hash ~ '^0x[0-9a-f]{64}$'
    ),
    provider_evidence_hash text CHECK (
        provider_evidence_hash IS NULL OR provider_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    verified_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (owner_wallet, idempotency_key),
    CHECK (expires_at > created_at),
    CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'PRODUCT_VIDEO') AND resource_type = 'PRODUCT')
        OR (purpose = 'CATEGORY_ICON' AND resource_type = 'CATEGORY')
        OR (purpose = 'STORE_IMAGE' AND resource_type = 'STORE')
        OR (purpose = 'FULFILLMENT_EVIDENCE' AND resource_type = 'ORDER')
    ),
    CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'CATEGORY_ICON', 'STORE_IMAGE')
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp'))
        OR (purpose = 'PRODUCT_VIDEO' AND content_type = 'video/mp4')
        OR (purpose = 'FULFILLMENT_EVIDENCE'
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
    ),
    CHECK (
        (state = 'PENDING' AND provider_reference_hash IS NULL AND provider_evidence_hash IS NULL AND verified_at IS NULL)
        OR (state = 'UPLOADED' AND provider_reference_hash IS NOT NULL AND provider_evidence_hash IS NULL AND verified_at IS NULL)
        OR (state = 'VERIFIED' AND provider_reference_hash IS NOT NULL AND provider_evidence_hash IS NOT NULL AND verified_at IS NOT NULL)
        OR (state = 'REJECTED' AND provider_evidence_hash IS NULL AND verified_at IS NULL)
    )
);

CREATE TABLE core.media_upload_wallet_locks (
    owner_wallet text PRIMARY KEY CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
    updated_at timestamptz NOT NULL
);

CREATE TABLE core.media_assets (
    asset_id text PRIMARY KEY CHECK (asset_id ~ '^0x[0-9a-f]{64}$'),
    upload_intent_id text NOT NULL UNIQUE REFERENCES core.media_upload_intents(upload_intent_id),
    owner_wallet text NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
    purpose text NOT NULL CHECK (purpose IN (
        'PRODUCT_IMAGE', 'PRODUCT_VIDEO', 'CATEGORY_ICON',
        'STORE_IMAGE', 'FULFILLMENT_EVIDENCE'
    )),
    resource_type text NOT NULL CHECK (resource_type IN ('PRODUCT', 'CATEGORY', 'STORE', 'ORDER')),
    resource_id text NOT NULL,
    object_key text NOT NULL UNIQUE,
    content_type text NOT NULL CHECK (content_type IN (
        'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'
    )),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^0x[0-9a-f]{64}$'),
    provider_evidence_hash text NOT NULL CHECK (provider_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    object_version_hash text NOT NULL CHECK (object_version_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'PRODUCT_VIDEO') AND resource_type = 'PRODUCT')
        OR (purpose = 'CATEGORY_ICON' AND resource_type = 'CATEGORY')
        OR (purpose = 'STORE_IMAGE' AND resource_type = 'STORE')
        OR (purpose = 'FULFILLMENT_EVIDENCE' AND resource_type = 'ORDER')
    ),
    CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'CATEGORY_ICON', 'STORE_IMAGE')
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp'))
        OR (purpose = 'PRODUCT_VIDEO' AND content_type = 'video/mp4')
        OR (purpose = 'FULFILLMENT_EVIDENCE'
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
    )
);

CREATE TABLE core.evidence_envelopes (
    evidence_hash text PRIMARY KEY CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    owner_wallet text NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
    actor_role text NOT NULL CHECK (actor_role IN ('BUYER', 'MERCHANT', 'ADMIN', 'OPERATOR')),
    purpose text NOT NULL CHECK (purpose IN ('FULFILLMENT_ACTION', 'SHIPMENT_TRACKING')),
    resource_type text NOT NULL CHECK (resource_type = 'ORDER'),
    resource_id text NOT NULL REFERENCES core.orders(order_id),
    action_type text NOT NULL CHECK (action_type IN (
        'REQUEST_EXCHANGE', 'REQUEST_DELAY', 'CONFIRM_RECEIPT',
        'OPEN_ARBITRATION', 'VERIFY_PICKUP', 'REQUEST_FORCED_RECEIPT',
        'RECORD_SHIPMENT'
    )),
    reason_code text,
    tracking_number_hash text CHECK (
        tracking_number_hash IS NULL OR tracking_number_hash ~ '^0x[0-9a-f]{64}$'
    ),
    media_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(media_asset_ids) = 'array'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    created_at timestamptz NOT NULL,
    UNIQUE (owner_wallet, idempotency_key),
    CHECK ((purpose = 'SHIPMENT_TRACKING') = (tracking_number_hash IS NOT NULL)),
    CHECK ((purpose = 'SHIPMENT_TRACKING') = (action_type = 'RECORD_SHIPMENT')),
    CHECK ((purpose = 'FULFILLMENT_ACTION') = (reason_code IS NOT NULL))
);

CREATE FUNCTION core.protect_media_upload_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.upload_intent_id IS DISTINCT FROM OLD.upload_intent_id
        OR NEW.owner_wallet IS DISTINCT FROM OLD.owner_wallet
        OR NEW.purpose IS DISTINCT FROM OLD.purpose
        OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
        OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
        OR NEW.object_key IS DISTINCT FROM OLD.object_key
        OR NEW.content_type IS DISTINCT FROM OLD.content_type
        OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
        OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.state IN ('VERIFIED', 'REJECTED')
        OR (OLD.state = 'PENDING' AND NEW.state NOT IN ('PENDING', 'UPLOADED', 'REJECTED'))
        OR (OLD.state = 'UPLOADED' AND NEW.state NOT IN ('UPLOADED', 'VERIFIED', 'REJECTED'))
        OR (OLD.provider_reference_hash IS NOT NULL
            AND NEW.provider_reference_hash IS DISTINCT FROM OLD.provider_reference_hash)
        OR (OLD.provider_evidence_hash IS NOT NULL
            AND NEW.provider_evidence_hash IS DISTINCT FROM OLD.provider_evidence_hash)
        OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
    THEN
        RAISE EXCEPTION 'InvalidMediaUploadTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER media_upload_intents_protect
    BEFORE UPDATE ON core.media_upload_intents
    FOR EACH ROW EXECUTE FUNCTION core.protect_media_upload_intent();

CREATE TRIGGER media_assets_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.media_assets
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER evidence_envelopes_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.evidence_envelopes
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
