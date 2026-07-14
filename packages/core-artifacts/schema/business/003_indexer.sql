CREATE TABLE core.chain_blocks (
    block_hash text PRIMARY KEY CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    parent_hash text NOT NULL CHECK (parent_hash ~ '^0x[0-9a-fA-F]{64}$'),
    block_timestamp bigint NOT NULL CHECK (block_timestamp > 0),
    canonical boolean NOT NULL DEFAULT true,
    indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    replaced_at timestamptz
);

CREATE UNIQUE INDEX chain_blocks_one_canonical_height_idx
    ON core.chain_blocks (block_number)
    WHERE canonical;

CREATE TABLE core.chain_events (
    block_hash text NOT NULL REFERENCES core.chain_blocks(block_hash),
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
    log_index bigint NOT NULL CHECK (log_index >= 0),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    artifact_version text NOT NULL,
    contract_name text NOT NULL,
    event_name text NOT NULL,
    event_signature text NOT NULL,
    resource_id text NOT NULL,
    values jsonb NOT NULL CHECK (jsonb_typeof(values) = 'object'),
    canonical boolean NOT NULL DEFAULT true,
    indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    replaced_at timestamptz,
    PRIMARY KEY (block_hash, transaction_hash, log_index)
);

CREATE INDEX chain_events_canonical_resource_idx
    ON core.chain_events (resource_id, block_number, log_index)
    WHERE canonical;

CREATE TABLE core.chain_reorg_evidence (
    reorg_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_block bigint NOT NULL CHECK (from_block >= 0),
    expected_hash text NOT NULL CHECK (expected_hash ~ '^0x[0-9a-fA-F]{64}$'),
    observed_hash text NOT NULL CHECK (observed_hash ~ '^0x[0-9a-fA-F]{64}$'),
    status text NOT NULL CHECK (status IN ('PENDING', 'RECONCILED')),
    common_ancestor bigint,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
