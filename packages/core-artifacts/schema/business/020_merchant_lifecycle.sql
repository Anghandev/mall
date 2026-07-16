ALTER TABLE core.merchants
    ADD COLUMN application_version bigint NOT NULL DEFAULT 0 CHECK (application_version >= 0),
    ADD COLUMN reviewed_at timestamptz,
    ADD COLUMN reviewed_by text CHECK (reviewed_by IS NULL OR reviewed_by ~ '^0x[0-9a-fA-F]{40}$');

ALTER TABLE core.wallet_role_bindings
    ADD CONSTRAINT wallet_role_bindings_merchant_fk
    FOREIGN KEY (merchant_id) REFERENCES core.merchants(merchant_id);

CREATE TABLE core.merchant_application_versions (
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    version bigint NOT NULL CHECK (version > 0),
    encrypted_payload bytea NOT NULL,
    encryption_iv bytea NOT NULL CHECK (octet_length(encryption_iv) = 12),
    encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
    payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
    license_asset_id text REFERENCES core.media_assets(asset_id),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (merchant_id, version),
    UNIQUE (actor_wallet, idempotency_key)
);

CREATE TABLE core.merchant_review_actions (
    action_id text PRIMARY KEY CHECK (action_id ~ '^0x[0-9a-f]{64}$'),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    action_kind text NOT NULL CHECK (action_kind IN ('APPROVE', 'REJECT', 'BLACKLIST')),
    from_status text NOT NULL CHECK (from_status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'BLACKLISTED')),
    to_status text NOT NULL CHECK (to_status IN ('APPROVED', 'REJECTED', 'BLACKLISTED')),
    application_version bigint NOT NULL CHECK (application_version > 0),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_:-]{2,64}$'),
    old_value_hash text NOT NULL CHECK (old_value_hash ~ '^0x[0-9a-f]{64}$'),
    new_value_hash text NOT NULL CHECK (new_value_hash ~ '^0x[0-9a-f]{64}$'),
    approval_nonce numeric(78, 0) NOT NULL CHECK (approval_nonce >= 0),
    approval_deadline timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('DRAFT', 'PUBLISHED', 'EXPIRED')),
    secondary_signer text CHECK (secondary_signer IS NULL OR secondary_signer ~ '^0x[0-9a-fA-F]{40}$'),
    secondary_signature_hash text CHECK (secondary_signature_hash IS NULL OR secondary_signature_hash ~ '^0x[0-9a-f]{64}$'),
    action_digest text CHECK (action_digest IS NULL OR action_digest ~ '^0x[0-9a-f]{64}$'),
    governance_safe_address text NOT NULL CHECK (governance_safe_address ~ '^0x[0-9a-fA-F]{40}$'),
    safe_tx_hash text CHECK (safe_tx_hash IS NULL OR safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    approval_evidence_hash text CHECK (approval_evidence_hash IS NULL OR approval_evidence_hash ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key),
    CHECK (approval_deadline > created_at),
    CHECK (
        (state = 'DRAFT' AND secondary_signer IS NULL AND secondary_signature_hash IS NULL
            AND action_digest IS NULL AND safe_tx_hash IS NULL AND approval_evidence_hash IS NULL)
        OR (state = 'PUBLISHED' AND secondary_signer IS NOT NULL AND secondary_signature_hash IS NOT NULL
            AND action_digest IS NOT NULL AND safe_tx_hash IS NOT NULL AND approval_evidence_hash IS NOT NULL)
        OR (state = 'EXPIRED' AND safe_tx_hash IS NULL AND approval_evidence_hash IS NULL)
    )
);

ALTER TABLE core.media_upload_intents
    DROP CONSTRAINT media_upload_intents_purpose_check,
    DROP CONSTRAINT media_upload_intents_resource_match_check,
    DROP CONSTRAINT media_upload_intents_content_match_check,
    ADD CONSTRAINT media_upload_intents_purpose_check CHECK (purpose IN (
        'PRODUCT_IMAGE', 'PRODUCT_VIDEO', 'CATEGORY_ICON', 'STORE_IMAGE',
        'FULFILLMENT_EVIDENCE', 'BUYER_AVATAR', 'MERCHANT_LOGO', 'MERCHANT_LICENSE'
    )),
    ADD CONSTRAINT media_upload_intents_resource_match_check CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'PRODUCT_VIDEO') AND resource_type = 'PRODUCT')
        OR (purpose = 'CATEGORY_ICON' AND resource_type = 'CATEGORY')
        OR (purpose = 'STORE_IMAGE' AND resource_type = 'STORE')
        OR (purpose = 'FULFILLMENT_EVIDENCE' AND resource_type = 'ORDER')
        OR (purpose = 'BUYER_AVATAR' AND resource_type = 'BUYER')
        OR (purpose IN ('MERCHANT_LOGO', 'MERCHANT_LICENSE') AND resource_type = 'MERCHANT')
    ),
    ADD CONSTRAINT media_upload_intents_content_match_check CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'CATEGORY_ICON', 'STORE_IMAGE', 'BUYER_AVATAR', 'MERCHANT_LOGO')
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp'))
        OR (purpose = 'PRODUCT_VIDEO' AND content_type = 'video/mp4')
        OR (purpose IN ('FULFILLMENT_EVIDENCE', 'MERCHANT_LICENSE')
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
    );

ALTER TABLE core.media_assets
    DROP CONSTRAINT media_assets_purpose_check,
    DROP CONSTRAINT media_assets_resource_match_check,
    DROP CONSTRAINT media_assets_content_match_check,
    ADD CONSTRAINT media_assets_purpose_check CHECK (purpose IN (
        'PRODUCT_IMAGE', 'PRODUCT_VIDEO', 'CATEGORY_ICON', 'STORE_IMAGE',
        'FULFILLMENT_EVIDENCE', 'BUYER_AVATAR', 'MERCHANT_LOGO', 'MERCHANT_LICENSE'
    )),
    ADD CONSTRAINT media_assets_resource_match_check CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'PRODUCT_VIDEO') AND resource_type = 'PRODUCT')
        OR (purpose = 'CATEGORY_ICON' AND resource_type = 'CATEGORY')
        OR (purpose = 'STORE_IMAGE' AND resource_type = 'STORE')
        OR (purpose = 'FULFILLMENT_EVIDENCE' AND resource_type = 'ORDER')
        OR (purpose = 'BUYER_AVATAR' AND resource_type = 'BUYER')
        OR (purpose IN ('MERCHANT_LOGO', 'MERCHANT_LICENSE') AND resource_type = 'MERCHANT')
    ),
    ADD CONSTRAINT media_assets_content_match_check CHECK (
        (purpose IN ('PRODUCT_IMAGE', 'CATEGORY_ICON', 'STORE_IMAGE', 'BUYER_AVATAR', 'MERCHANT_LOGO')
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp'))
        OR (purpose = 'PRODUCT_VIDEO' AND content_type = 'video/mp4')
        OR (purpose IN ('FULFILLMENT_EVIDENCE', 'MERCHANT_LICENSE')
            AND content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
    );

CREATE INDEX merchants_lifecycle_cursor_idx
    ON core.merchants (status, created_at DESC, merchant_id DESC);
CREATE INDEX merchant_review_actions_merchant_idx
    ON core.merchant_review_actions (merchant_id, created_at DESC, action_id DESC);
CREATE TRIGGER merchant_application_versions_immutable
    BEFORE UPDATE OR DELETE ON core.merchant_application_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE FUNCTION core.protect_merchant_review_action() RETURNS trigger
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
        OR NEW.governance_safe_address IS DISTINCT FROM OLD.governance_safe_address
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

CREATE TRIGGER merchant_review_actions_protected
    BEFORE UPDATE OR DELETE ON core.merchant_review_actions
    FOR EACH ROW EXECUTE FUNCTION core.protect_merchant_review_action();
