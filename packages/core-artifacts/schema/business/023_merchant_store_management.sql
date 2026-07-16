ALTER TABLE core.merchant_stores
    DROP CONSTRAINT merchant_stores_status_check,
    ADD COLUMN business_hours text NOT NULL DEFAULT '' CHECK (length(business_hours) <= 240),
    ADD COLUMN image_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        jsonb_typeof(image_asset_ids) = 'array' AND jsonb_array_length(image_asset_ids) <= 5
    ),
    ADD CONSTRAINT merchant_stores_status_check CHECK (status IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED'));

CREATE TABLE core.merchant_store_commands (
    command_id text PRIMARY KEY,
    store_id text NOT NULL REFERENCES core.merchant_stores(store_id),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    command_type text NOT NULL CHECK (command_type IN ('CREATE', 'UPDATE_PROFILE', 'ACTIVATE', 'CLOSE')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-fA-F]{64}$'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key)
);

CREATE TABLE core.merchant_store_versions (
    store_id text NOT NULL REFERENCES core.merchant_stores(store_id),
    version bigint NOT NULL CHECK (version > 0),
    command_id text REFERENCES core.merchant_store_commands(command_id),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    business_hours text NOT NULL CHECK (length(business_hours) <= 240),
    image_asset_ids jsonb NOT NULL CHECK (
        jsonb_typeof(image_asset_ids) = 'array' AND jsonb_array_length(image_asset_ids) <= 5
    ),
    phone text NOT NULL CHECK (phone ~ '^[+]?[0-9-]{7,20}$'),
    status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, version)
);

INSERT INTO core.merchant_store_versions (
    store_id, version, command_id, name, business_hours, image_asset_ids,
    phone, status, actor_wallet, created_at
)
SELECT store.store_id, store.version, NULL, store.name, store.business_hours, store.image_asset_ids,
       store.phone, store.status, lower(merchant.settlement_wallet), store.created_at
FROM core.merchant_stores store
JOIN core.merchants merchant ON merchant.merchant_id = store.merchant_id;

CREATE FUNCTION core.protect_merchant_store_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.store_id IS DISTINCT FROM OLD.store_id
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
        OR NEW.region_code IS DISTINCT FROM OLD.region_code
        OR NEW.longitude IS DISTINCT FROM OLD.longitude
        OR NEW.latitude IS DISTINCT FROM OLD.latitude
        OR NEW.address IS DISTINCT FROM OLD.address
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'ImmutableStoreLocation' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'InvalidStoreVersion' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER merchant_stores_protect_identity
    BEFORE UPDATE ON core.merchant_stores
    FOR EACH ROW EXECUTE FUNCTION core.protect_merchant_store_identity();

CREATE TRIGGER merchant_store_commands_no_mutation
    BEFORE UPDATE OR DELETE ON core.merchant_store_commands
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER merchant_store_versions_no_mutation
    BEFORE UPDATE OR DELETE ON core.merchant_store_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
