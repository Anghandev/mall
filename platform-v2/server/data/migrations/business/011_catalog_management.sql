ALTER TABLE core.products
    DROP CONSTRAINT products_lifecycle_state_check,
    ADD CONSTRAINT products_lifecycle_state_check CHECK (lifecycle_state IN (
        'DRAFT', 'REVIEW', 'SCHEDULED', 'ACTIVE', 'SOLD_OUT',
        'HIDDEN', 'DELISTED', 'LOCKED'
    )),
    ADD COLUMN store_id text REFERENCES core.merchant_stores(store_id),
    ADD COLUMN supersedes_product_id text REFERENCES core.products(product_id),
    ADD COLUMN subtitle text NOT NULL DEFAULT '' CHECK (length(subtitle) <= 120),
    ADD COLUMN main_image_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(main_image_asset_ids) = 'array'),
    ADD COLUMN video_asset_id text,
    ADD COLUMN rich_detail jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(rich_detail) = 'object'),
    ADD COLUMN default_freight_usdt numeric(78, 0) NOT NULL DEFAULT 0
        CHECK (default_freight_usdt >= 0),
    ADD COLUMN fulfillment_modes jsonb NOT NULL DEFAULT '["DELIVERY"]'::jsonb
        CHECK (jsonb_typeof(fulfillment_modes) = 'array'),
    ADD COLUMN submission_hash text CHECK (
        submission_hash IS NULL OR submission_hash ~ '^0x[0-9a-f]{64}$'
    );

ALTER TABLE core.products
    ADD CONSTRAINT products_title_length_check CHECK (length(title) BETWEEN 1 AND 60);

CREATE UNIQUE INDEX products_current_store_slot_idx
    ON core.products (store_id)
    WHERE store_id IS NOT NULL AND lifecycle_state NOT IN ('HIDDEN', 'DELISTED');

ALTER TABLE core.skus
    DROP CONSTRAINT skus_lifecycle_state_check,
    ADD CONSTRAINT skus_lifecycle_state_check CHECK (lifecycle_state IN (
        'DRAFT', 'REVIEW', 'SCHEDULED', 'ACTIVE', 'SOLD_OUT', 'LOCKED', 'DELISTED'
    )),
    ADD COLUMN proposed_seckill_inventory bigint NOT NULL DEFAULT 1
        CHECK (proposed_seckill_inventory > 0);

CREATE TABLE core.catalog_categories (
    category_id text PRIMARY KEY,
    current_version bigint NOT NULL CHECK (current_version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.catalog_category_versions (
    category_id text NOT NULL REFERENCES core.catalog_categories(category_id),
    version bigint NOT NULL CHECK (version > 0),
    parent_category_id text REFERENCES core.catalog_categories(category_id),
    level smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    icon_asset_id text,
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    service_fee_bps integer CHECK (service_fee_bps BETWEEN 0 AND 10000),
    status text NOT NULL CHECK (status IN ('ENABLED', 'DISABLED', 'DELETED')),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (category_id, version),
    UNIQUE (created_by, idempotency_key),
    CHECK ((level = 1) = (parent_category_id IS NULL))
);

ALTER TABLE core.catalog_categories
    ADD CONSTRAINT catalog_categories_current_version_fk
    FOREIGN KEY (category_id, current_version)
    REFERENCES core.catalog_category_versions(category_id, version)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE core.catalog_tags (
    tag_id text PRIMARY KEY,
    current_version bigint NOT NULL CHECK (current_version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.catalog_tag_versions (
    tag_id text NOT NULL REFERENCES core.catalog_tags(tag_id),
    version bigint NOT NULL CHECK (version > 0),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    example text NOT NULL DEFAULT '' CHECK (length(example) <= 240),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    status text NOT NULL CHECK (status IN ('ENABLED', 'DISABLED', 'DELETED')),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tag_id, version),
    UNIQUE (created_by, idempotency_key)
);

ALTER TABLE core.catalog_tags
    ADD CONSTRAINT catalog_tags_current_version_fk
    FOREIGN KEY (tag_id, current_version)
    REFERENCES core.catalog_tag_versions(tag_id, version)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE core.product_category_assignments (
    product_id text NOT NULL REFERENCES core.products(product_id),
    product_version bigint NOT NULL CHECK (product_version > 0),
    category_id text NOT NULL REFERENCES core.catalog_categories(category_id),
    assigned_by text NOT NULL CHECK (assigned_by ~ '^0x[0-9a-f]{40}$'),
    assigned_at timestamptz NOT NULL,
    PRIMARY KEY (product_id, product_version, category_id)
);

CREATE TABLE core.product_tag_assignments (
    product_id text NOT NULL REFERENCES core.products(product_id),
    product_version bigint NOT NULL CHECK (product_version > 0),
    tag_id text NOT NULL REFERENCES core.catalog_tags(tag_id),
    assigned_by text NOT NULL CHECK (assigned_by ~ '^0x[0-9a-f]{40}$'),
    assigned_at timestamptz NOT NULL,
    PRIMARY KEY (product_id, product_version, tag_id)
);

CREATE TABLE core.catalog_commands (
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    command_scope text NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    resource_id text NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (actor_wallet, command_scope, idempotency_key)
);

CREATE TABLE core.product_review_events (
    review_event_id text PRIMARY KEY CHECK (review_event_id ~ '^0x[0-9a-f]{64}$'),
    product_id text NOT NULL REFERENCES core.products(product_id),
    product_version bigint NOT NULL CHECK (product_version > 0),
    decision text NOT NULL CHECK (decision IN (
        'SUBMITTED', 'APPROVED', 'REJECTED', 'PUBLISHED', 'HIDDEN', 'DELISTED'
    )),
    from_state text NOT NULL,
    to_state text NOT NULL,
    reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    created_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key)
);

CREATE TABLE core.catalog_inventory_adjustments (
    adjustment_id text PRIMARY KEY CHECK (adjustment_id ~ '^0x[0-9a-f]{64}$'),
    sku_id text NOT NULL REFERENCES core.skus(sku_id),
    before_total bigint NOT NULL CHECK (before_total >= 0),
    before_available bigint NOT NULL CHECK (before_available >= 0),
    delta bigint NOT NULL CHECK (delta <> 0),
    after_total bigint NOT NULL CHECK (after_total >= 0),
    after_available bigint NOT NULL CHECK (after_available >= 0),
    reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    created_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key),
    CHECK (after_total = before_total + delta),
    CHECK (after_available = before_available + delta)
);

CREATE TABLE core.merchant_concession_previews (
    preview_id text PRIMARY KEY CHECK (preview_id ~ '^0x[0-9a-f]{64}$'),
    product_id text NOT NULL REFERENCES core.products(product_id),
    product_version bigint NOT NULL CHECK (product_version > 0),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    concession_bps integer NOT NULL CHECK (concession_bps BETWEEN 0 AND 10000),
    catalog_fingerprint text NOT NULL CHECK (catalog_fingerprint ~ '^0x[0-9a-f]{64}$'),
    destination_set_hash text NOT NULL CHECK (destination_set_hash ~ '^0x[0-9a-f]{64}$'),
    preview_hash text NOT NULL CHECK (preview_hash ~ '^0x[0-9a-f]{64}$'),
    authorization_digest text NOT NULL CHECK (authorization_digest ~ '^0x[0-9a-f]{64}$'),
    signature text NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]+$'),
    signer text NOT NULL CHECK (signer ~ '^0x[0-9a-f]{40}$'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (created_by, idempotency_key),
    CHECK (expires_at > created_at)
);

ALTER TABLE core.products
    ADD COLUMN submission_preview_id text
    REFERENCES core.merchant_concession_previews(preview_id);

CREATE INDEX product_review_events_product_idx
    ON core.product_review_events (product_id, created_at, review_event_id);
CREATE INDEX inventory_adjustments_sku_idx
    ON core.catalog_inventory_adjustments (sku_id, created_at, adjustment_id);
CREATE INDEX concession_previews_product_idx
    ON core.merchant_concession_previews (product_id, created_at DESC);

CREATE TRIGGER catalog_category_versions_no_mutation
    BEFORE UPDATE OR DELETE ON core.catalog_category_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER catalog_tag_versions_no_mutation
    BEFORE UPDATE OR DELETE ON core.catalog_tag_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER product_category_assignments_no_mutation
    BEFORE UPDATE OR DELETE ON core.product_category_assignments
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER product_tag_assignments_no_mutation
    BEFORE UPDATE OR DELETE ON core.product_tag_assignments
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER catalog_commands_no_mutation
    BEFORE UPDATE OR DELETE ON core.catalog_commands
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER product_review_events_no_mutation
    BEFORE UPDATE OR DELETE ON core.product_review_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER catalog_inventory_adjustments_no_mutation
    BEFORE UPDATE OR DELETE ON core.catalog_inventory_adjustments
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER merchant_concession_previews_no_mutation
    BEFORE UPDATE OR DELETE ON core.merchant_concession_previews
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
