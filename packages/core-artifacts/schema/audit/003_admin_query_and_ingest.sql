ALTER TABLE audit.entries
    ADD COLUMN source_event_id text UNIQUE,
    ADD COLUMN authorization_evidence jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(authorization_evidence) = 'object'),
    ADD COLUMN evidence_profile text;

UPDATE audit.entries SET evidence_profile = CASE
    WHEN transaction_evidence <> '{}'::jsonb THEN 'CHAIN_OBSERVED'
    WHEN signature_evidence <> '{}'::jsonb THEN 'SIGNED_OFFCHAIN'
    WHEN authorization_evidence <> '{}'::jsonb THEN 'RBAC'
    ELSE 'SYSTEM'
END;

ALTER TABLE audit.entries
    ALTER COLUMN evidence_profile SET NOT NULL,
    ADD CONSTRAINT audit_entries_evidence_profile_check CHECK (evidence_profile IN (
        'RBAC', 'AUTHORIZATION', 'SIGNED_OFFCHAIN', 'SAFE_APPROVED',
        'CHAIN_OBSERVED', 'CHAIN_FINAL', 'SYSTEM'
    ));

ALTER TABLE audit.entries
    DROP CONSTRAINT audit_entries_stream_evidence_check,
    ADD CONSTRAINT audit_entries_stream_evidence_check CHECK (
        (evidence_profile IN ('RBAC', 'AUTHORIZATION')
            AND authorization_evidence <> '{}'::jsonb
            AND transaction_evidence = '{}'::jsonb)
        OR (evidence_profile IN ('SIGNED_OFFCHAIN', 'SAFE_APPROVED')
            AND signature_evidence <> '{}'::jsonb
            AND transaction_evidence = '{}'::jsonb)
        OR (evidence_profile = 'CHAIN_OBSERVED'
            AND transaction_evidence <> '{}'::jsonb)
        OR (evidence_profile = 'CHAIN_FINAL'
            AND transaction_evidence <> '{}'::jsonb
            AND transaction_evidence->>'blockHash' ~ '^0x[0-9a-fA-F]{64}$'
            AND transaction_evidence->>'confirmations' ~ '^[0-9]+$'
            AND (transaction_evidence->>'confirmations')::integer >= 15)
        OR (evidence_profile = 'SYSTEM'
            AND authorization_evidence = '{}'::jsonb
            AND signature_evidence = '{}'::jsonb
            AND transaction_evidence = '{}'::jsonb
            AND (event_type = 'BackupEvidence'
                OR payload->>'evidenceHash' ~ '^0x[0-9a-fA-F]{64}$'))
    );

CREATE INDEX audit_entries_filter_idx
    ON audit.entries (stream_name, event_type, created_at DESC, entry_id DESC);
CREATE INDEX audit_entries_actor_idx
    ON audit.entries (actor_wallet, created_at DESC, entry_id DESC)
    WHERE actor_wallet IS NOT NULL;

CREATE TABLE audit.retention_policies (
    policy_id text PRIMARY KEY,
    stream_name text NOT NULL UNIQUE CHECK (stream_name IN (
        'financial', 'governance', 'authentication', 'operational', 'backup'
    )),
    minimum_retention_days integer NOT NULL CHECK (minimum_retention_days >= 365),
    deletion_permitted boolean NOT NULL DEFAULT false CHECK (NOT deletion_permitted),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER audit_retention_policies_append_only
    BEFORE UPDATE OR DELETE ON audit.retention_policies
    FOR EACH ROW EXECUTE FUNCTION audit.reject_entry_mutation();
