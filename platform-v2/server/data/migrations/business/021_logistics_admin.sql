CREATE TABLE core.logistics_carrier_config_versions (
    config_version_id text PRIMARY KEY CHECK (config_version_id ~ '^0x[0-9a-f]{64}$'),
    version bigint NOT NULL UNIQUE CHECK (version > 0),
    default_carrier_code text NOT NULL CHECK (default_carrier_code IN ('SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (created_by, idempotency_key)
);

CREATE TABLE core.logistics_carrier_config_entries (
    config_version_id text NOT NULL REFERENCES core.logistics_carrier_config_versions(config_version_id),
    carrier_code text NOT NULL CHECK (carrier_code IN ('SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS')),
    enabled boolean NOT NULL,
    PRIMARY KEY (config_version_id, carrier_code)
);

CREATE TABLE core.logistics_provider_config_versions (
    provider_config_version_id text PRIMARY KEY CHECK (provider_config_version_id ~ '^0x[0-9a-f]{64}$'),
    provider text NOT NULL CHECK (provider IN ('KUAIDI100', 'CAINIAO')),
    version bigint NOT NULL CHECK (version > 0),
    enabled boolean NOT NULL,
    partner_id_secret_ref text NOT NULL CHECK (partner_id_secret_ref ~ '^(vault|secret)://[^[:space:]]+$'),
    credential_secret_ref text NOT NULL CHECK (credential_secret_ref ~ '^(vault|secret)://[^[:space:]]+$'),
    monthly_account_secret_ref text NOT NULL CHECK (monthly_account_secret_ref ~ '^(vault|secret)://[^[:space:]]+$'),
    callback_secret_ref text NOT NULL CHECK (callback_secret_ref ~ '^(vault|secret)://[^[:space:]]+$'),
    config_hash text NOT NULL CHECK (config_hash ~ '^0x[0-9a-f]{64}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (provider, version),
    UNIQUE (created_by, idempotency_key)
);

CREATE TABLE core.logistics_warehouse_versions (
    warehouse_version_id text PRIMARY KEY CHECK (warehouse_version_id ~ '^0x[0-9a-f]{64}$'),
    warehouse_id text NOT NULL CHECK (length(warehouse_id) BETWEEN 8 AND 128),
    version bigint NOT NULL CHECK (version > 0),
    warehouse_kind text NOT NULL CHECK (warehouse_kind IN ('PLATFORM', 'PARTNER')),
    name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
    partner_name text CHECK (partner_name IS NULL OR length(partner_name) BETWEEN 2 AND 120),
    region_code text NOT NULL CHECK (region_code ~ '^[0-9]{6}$'),
    encrypted_payload bytea NOT NULL,
    encryption_iv bytea NOT NULL,
    encryption_tag bytea NOT NULL,
    payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
    enabled boolean NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (warehouse_id, version),
    UNIQUE (created_by, idempotency_key),
    CHECK ((warehouse_kind = 'PARTNER') = (partner_name IS NOT NULL))
);

CREATE INDEX logistics_provider_current_idx
    ON core.logistics_provider_config_versions (provider, version DESC);
CREATE INDEX logistics_warehouse_current_idx
    ON core.logistics_warehouse_versions (warehouse_id, version DESC);

CREATE TRIGGER logistics_carrier_config_versions_immutable
    BEFORE UPDATE OR DELETE ON core.logistics_carrier_config_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER logistics_carrier_config_entries_immutable
    BEFORE UPDATE OR DELETE ON core.logistics_carrier_config_entries
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER logistics_provider_config_versions_immutable
    BEFORE UPDATE OR DELETE ON core.logistics_provider_config_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER logistics_warehouse_versions_immutable
    BEFORE UPDATE OR DELETE ON core.logistics_warehouse_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
