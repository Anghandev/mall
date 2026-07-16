CREATE TABLE core.admin_batch_operations (
    operation_id text PRIMARY KEY CHECK (operation_id ~ '^0x[0-9a-f]{64}$'),
    operation_type text NOT NULL CHECK (operation_type IN (
        'EXPORT_CSV', 'EXPORT_EXCEL', 'BATCH_ADD_PRODUCT_TAGS'
    )),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    actor_role text NOT NULL CHECK (actor_role IN ('ADMIN', 'OPERATOR', 'AUDITOR')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, operation_type, idempotency_key)
);

CREATE INDEX admin_batch_operations_created_idx
    ON core.admin_batch_operations (created_at DESC, operation_id DESC);

CREATE TRIGGER admin_batch_operations_immutable
    BEFORE UPDATE OR DELETE ON core.admin_batch_operations
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
