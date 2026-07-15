CREATE TABLE core.merchant_printer_binding_challenges (
    challenge_id text PRIMARY KEY CHECK (challenge_id ~ '^0x[0-9a-f]{64}$'),
    store_id text NOT NULL REFERENCES core.merchant_stores(store_id),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    provider text NOT NULL CHECK (provider IN ('FEIE', 'YILIANYUN')),
    device_id text NOT NULL CHECK (length(device_id) BETWEEN 3 AND 128),
    old_value_hash text NOT NULL CHECK (old_value_hash ~ '^0x[0-9a-f]{64}$'),
    new_value_hash text NOT NULL CHECK (new_value_hash ~ '^0x[0-9a-f]{64}$'),
    nonce numeric(78, 0) NOT NULL CHECK (nonce >= 0),
    deadline timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING', 'CONSUMED', 'EXPIRED')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    signature_hash text CHECK (signature_hash IS NULL OR signature_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    consumed_at timestamptz,
    UNIQUE (actor_wallet, idempotency_key),
    UNIQUE (actor_wallet, nonce),
    CHECK ((state = 'CONSUMED') = (consumed_at IS NOT NULL AND signature_hash IS NOT NULL))
);

CREATE TABLE core.merchant_printer_bindings (
    binding_id text PRIMARY KEY CHECK (binding_id ~ '^0x[0-9a-f]{64}$'),
    store_id text NOT NULL UNIQUE REFERENCES core.merchant_stores(store_id),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    provider text NOT NULL CHECK (provider IN ('FEIE', 'YILIANYUN')),
    device_id text NOT NULL CHECK (length(device_id) BETWEEN 3 AND 128),
    binding_hash text NOT NULL CHECK (binding_hash ~ '^0x[0-9a-f]{64}$'),
    version bigint NOT NULL CHECK (version > 0),
    verified_by_wallet text NOT NULL CHECK (verified_by_wallet ~ '^0x[0-9a-f]{40}$'),
    challenge_id text NOT NULL UNIQUE REFERENCES core.merchant_printer_binding_challenges(challenge_id),
    signature_hash text NOT NULL CHECK (signature_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE core.merchant_printer_binding_history (
    history_id text PRIMARY KEY CHECK (history_id ~ '^0x[0-9a-f]{64}$'),
    binding_id text NOT NULL REFERENCES core.merchant_printer_bindings(binding_id),
    store_id text NOT NULL REFERENCES core.merchant_stores(store_id),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    provider text NOT NULL CHECK (provider IN ('FEIE', 'YILIANYUN')),
    device_id text NOT NULL,
    binding_hash text NOT NULL CHECK (binding_hash ~ '^0x[0-9a-f]{64}$'),
    version bigint NOT NULL CHECK (version > 0),
    verified_by_wallet text NOT NULL CHECK (verified_by_wallet ~ '^0x[0-9a-f]{40}$'),
    challenge_id text NOT NULL REFERENCES core.merchant_printer_binding_challenges(challenge_id),
    signature_hash text NOT NULL CHECK (signature_hash ~ '^0x[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL,
    UNIQUE (binding_id, version)
);

CREATE TABLE core.waybill_batches (
    batch_id text PRIMARY KEY CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key)
);

CREATE TABLE core.waybill_requests (
    request_id text PRIMARY KEY CHECK (request_id ~ '^0x[0-9a-f]{64}$'),
    batch_id text NOT NULL REFERENCES core.waybill_batches(batch_id),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    store_id text NOT NULL REFERENCES core.merchant_stores(store_id),
    waybill_provider text NOT NULL CHECK (waybill_provider IN ('KUAIDI100', 'CAINIAO')),
    carrier_code text NOT NULL CHECK (carrier_code IN ('SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN (
        'PENDING_PROVIDER', 'CONFIGURATION_REQUIRED', 'PROVIDER_ACCEPTED',
        'SHIPMENT_RECORDED', 'COMPLETED', 'FAILED'
    )),
    provider_reference text,
    encrypted_tracking_number bytea,
    tracking_iv bytea,
    tracking_tag bytea,
    tracking_number_hash text CHECK (
        tracking_number_hash IS NULL OR tracking_number_hash ~ '^0x[0-9a-f]{64}$'
    ),
    shipment_evidence_hash text CHECK (
        shipment_evidence_hash IS NULL OR shipment_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    print_job_id text CHECK (print_job_id IS NULL OR print_job_id ~ '^0x[0-9a-f]{64}$'),
    error_code text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (merchant_id, idempotency_key),
    UNIQUE (batch_id, order_id),
    UNIQUE (order_id),
    CHECK (
        (state IN ('PENDING_PROVIDER', 'CONFIGURATION_REQUIRED')
            AND provider_reference IS NULL AND encrypted_tracking_number IS NULL)
        OR (state NOT IN ('PENDING_PROVIDER', 'CONFIGURATION_REQUIRED') AND provider_reference IS NOT NULL)
    ),
    CHECK (
        (encrypted_tracking_number IS NULL AND tracking_iv IS NULL AND tracking_tag IS NULL)
        OR (encrypted_tracking_number IS NOT NULL AND tracking_iv IS NOT NULL AND tracking_tag IS NOT NULL)
    )
);

CREATE TABLE core.print_jobs (
    print_job_id text PRIMARY KEY CHECK (print_job_id ~ '^0x[0-9a-f]{64}$'),
    merchant_id text NOT NULL REFERENCES core.merchants(merchant_id),
    store_id text NOT NULL REFERENCES core.merchant_stores(store_id),
    order_id text NOT NULL REFERENCES core.orders(order_id),
    job_kind text NOT NULL CHECK (job_kind IN ('WAYBILL', 'PICKUP_RECEIPT')),
    source_reference text NOT NULL,
    provider text CHECK (provider IS NULL OR provider IN ('FEIE', 'YILIANYUN')),
    device_id_snapshot text,
    copy_count integer NOT NULL CHECK (copy_count IN (1, 2)),
    encrypted_content bytea NOT NULL,
    content_iv bytea NOT NULL,
    content_tag bytea NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN (
        'CONFIGURATION_REQUIRED', 'QUEUED', 'PROCESSING', 'ACCEPTED', 'RETRYABLE', 'FAILED'
    )),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    next_attempt_at timestamptz,
    lease_token text,
    lease_expires_at timestamptz,
    provider_reference text,
    error_code text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (job_kind, source_reference),
    CHECK ((provider IS NULL) = (device_id_snapshot IS NULL)),
    CHECK ((state = 'PROCESSING') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK ((state = 'ACCEPTED') = (provider_reference IS NOT NULL))
);

ALTER TABLE core.waybill_requests
    ADD CONSTRAINT waybill_requests_print_job_fk
    FOREIGN KEY (print_job_id) REFERENCES core.print_jobs(print_job_id);

CREATE INDEX print_jobs_dispatch_idx
    ON core.print_jobs (state, next_attempt_at, created_at, print_job_id)
    WHERE state IN ('QUEUED', 'RETRYABLE', 'PROCESSING');

CREATE TABLE core.print_job_retry_commands (
    command_id text PRIMARY KEY CHECK (command_id ~ '^0x[0-9a-f]{64}$'),
    print_job_id text NOT NULL REFERENCES core.print_jobs(print_job_id),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key)
);

CREATE TRIGGER merchant_printer_binding_challenges_no_delete
    BEFORE DELETE ON core.merchant_printer_binding_challenges
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER merchant_printer_bindings_no_delete
    BEFORE DELETE ON core.merchant_printer_bindings
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER merchant_printer_binding_history_immutable
    BEFORE UPDATE OR DELETE ON core.merchant_printer_binding_history
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER waybill_batches_no_delete
    BEFORE DELETE ON core.waybill_batches
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER waybill_requests_no_delete
    BEFORE DELETE ON core.waybill_requests
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER print_jobs_no_delete
    BEFORE DELETE ON core.print_jobs
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER print_job_retry_commands_no_delete
    BEFORE DELETE ON core.print_job_retry_commands
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
