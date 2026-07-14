CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.stream_heads (
    stream_name text PRIMARY KEY,
    last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
    last_hash text NOT NULL CHECK (last_hash ~ '^[0-9a-f]{64}$'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE audit.entries (
    entry_id text PRIMARY KEY,
    stream_name text NOT NULL,
    sequence bigint NOT NULL CHECK (sequence > 0),
    event_type text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    actor_wallet text,
    actor_role text,
    correlation_id text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    signature_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(signature_evidence) = 'object'),
    transaction_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(transaction_evidence) = 'object'),
    previous_hash text NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
    entry_hash text NOT NULL UNIQUE CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (stream_name, sequence)
);

CREATE INDEX audit_entries_reverse_time_idx ON audit.entries (created_at DESC, entry_id DESC);
CREATE INDEX audit_entries_resource_idx ON audit.entries (resource_type, resource_id, sequence);
CREATE INDEX audit_entries_correlation_idx ON audit.entries (correlation_id, sequence);

CREATE FUNCTION audit.reject_entry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'AppendOnlyAudit' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER audit_entries_append_only
    BEFORE UPDATE OR DELETE ON audit.entries
    FOR EACH ROW EXECUTE FUNCTION audit.reject_entry_mutation();
