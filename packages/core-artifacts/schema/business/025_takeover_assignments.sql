CREATE TABLE core.takeover_assignments (
    assignment_id text PRIMARY KEY CHECK (assignment_id ~ '^0x[0-9a-f]{64}$'),
    case_id text NOT NULL REFERENCES core.takeover_cases(case_id),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    assignment_version bigint NOT NULL CHECK (assignment_version > 0),
    original_merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    replacement_merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    replacement_wallet text NOT NULL CHECK (replacement_wallet ~ '^0x[0-9a-f]{40}$'),
    replacement_application_version bigint NOT NULL CHECK (replacement_application_version > 0),
    replacement_level text NOT NULL CHECK (replacement_level IN ('V1', 'V2', 'V3', 'V4', 'V5')),
    replacement_license_asset_id text NOT NULL REFERENCES core.media_assets(asset_id),
    supersedes_assignment_id text UNIQUE REFERENCES core.takeover_assignments(assignment_id),
    reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_:-]{2,64}$'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    assigned_by text NOT NULL CHECK (assigned_by ~ '^0x[0-9a-f]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
    assigned_at timestamptz NOT NULL,
    UNIQUE (case_id, assignment_version),
    UNIQUE (assigned_by, idempotency_key),
    CHECK (original_merchant_id <> replacement_merchant_id),
    CHECK (
        (assignment_version = 1 AND supersedes_assignment_id IS NULL)
        OR (assignment_version > 1 AND supersedes_assignment_id IS NOT NULL)
    )
);

CREATE INDEX takeover_assignments_current_idx
    ON core.takeover_assignments (case_id, assignment_version DESC);
CREATE INDEX takeover_assignments_merchant_idx
    ON core.takeover_assignments (replacement_merchant_id, assigned_at DESC, assignment_id DESC);
CREATE TRIGGER takeover_assignments_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.takeover_assignments
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

ALTER TABLE core.takeover_replacement_fulfillment_snapshots
    ADD COLUMN assignment_id text NOT NULL UNIQUE
        REFERENCES core.takeover_assignments(assignment_id);
