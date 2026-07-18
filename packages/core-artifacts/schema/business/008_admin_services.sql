ALTER TABLE core.policy_drafts
    DROP CONSTRAINT policy_drafts_state_check,
    DROP CONSTRAINT policy_drafts_next_policy_version_state_key,
    ADD COLUMN artifact_version text,
    ADD COLUMN idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 128),
    ADD COLUMN request_hash text CHECK (request_hash IS NULL OR request_hash ~ '^0x[0-9a-f]{64}$'),
    ADD COLUMN policy_hash text CHECK (policy_hash IS NULL OR policy_hash ~ '^0x[0-9a-f]{64}$'),
    ADD COLUMN operations_hash text CHECK (operations_hash IS NULL OR operations_hash ~ '^0x[0-9a-f]{64}$'),
    ADD COLUMN publication_digest text CHECK (publication_digest IS NULL OR publication_digest ~ '^0x[0-9a-f]{64}$'),
    ADD COLUMN publication_nonce numeric(78, 0) CHECK (publication_nonce IS NULL OR publication_nonce >= 0),
    ADD COLUMN publication_deadline timestamptz,
    ADD COLUMN secondary_signer text CHECK (secondary_signer IS NULL OR secondary_signer ~ '^0x[0-9a-f]{40}$'),
    ADD COLUMN secondary_signature text,
    ADD COLUMN safe_address text CHECK (safe_address IS NULL OR safe_address ~ '^0x[0-9a-f]{40}$'),
    ADD COLUMN safe_calldata text CHECK (safe_calldata IS NULL OR safe_calldata ~ '^0x[0-9a-fA-F]+$'),
    ADD COLUMN safe_calldata_hash text CHECK (safe_calldata_hash IS NULL OR safe_calldata_hash ~ '^0x[0-9a-f]{64}$'),
    ADD COLUMN safe_tx_hash text CHECK (safe_tx_hash IS NULL OR safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    ADD CONSTRAINT policy_drafts_state_check CHECK (state IN (
        'DRAFT', 'DECISION_BLOCKED', 'SECONDARY_SIGNED', 'SAFE_PROPOSED',
        'FINALITY_PENDING', 'REORGED', 'REJECTED', 'PUBLISHED'
    )),
    ADD CONSTRAINT policy_drafts_publication_evidence_check CHECK (
        state IN ('DRAFT', 'DECISION_BLOCKED', 'REJECTED')
        OR (
            artifact_version IS NOT NULL
            AND request_hash IS NOT NULL
            AND policy_hash IS NOT NULL
            AND operations_hash IS NOT NULL
            AND publication_digest IS NOT NULL
            AND publication_nonce IS NOT NULL
            AND publication_deadline IS NOT NULL
            AND secondary_signer IS NOT NULL
            AND secondary_signature IS NOT NULL
            AND secondary_signature_hash IS NOT NULL
            AND safe_address IS NOT NULL
            AND safe_calldata IS NOT NULL
            AND safe_calldata_hash IS NOT NULL
        )
    ),
    ADD CONSTRAINT policy_drafts_safe_proposal_check CHECK (
        state NOT IN ('SAFE_PROPOSED', 'FINALITY_PENDING', 'REORGED', 'PUBLISHED')
        OR (safe_tx_hash IS NOT NULL AND safe_proposal_hash IS NOT NULL)
    );

CREATE UNIQUE INDEX policy_drafts_active_version_idx
    ON core.policy_drafts (next_policy_version)
    WHERE state <> 'REJECTED';
CREATE UNIQUE INDEX policy_drafts_publication_nonce_idx
    ON core.policy_drafts (secondary_signer, publication_nonce)
    WHERE publication_nonce IS NOT NULL;
CREATE UNIQUE INDEX policy_drafts_creator_idempotency_idx
    ON core.policy_drafts (created_by, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE core.policy_draft_transitions (
    transition_id text PRIMARY KEY,
    draft_id text NOT NULL REFERENCES core.policy_drafts(draft_id),
    from_state text,
    to_state text NOT NULL CHECK (to_state IN (
        'DRAFT', 'DECISION_BLOCKED', 'SECONDARY_SIGNED', 'SAFE_PROPOSED',
        'FINALITY_PENDING', 'REORGED', 'REJECTED', 'PUBLISHED'
    )),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (draft_id, evidence_hash)
);

CREATE TABLE core.policy_publication_transitions (
    transition_id text PRIMARY KEY,
    transition_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    draft_id text REFERENCES core.policy_drafts(draft_id),
    event_type text NOT NULL CHECK (event_type IN ('FINAL', 'REORGED')),
    safe_tx_hash text CHECK (safe_tx_hash IS NULL OR safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    execution_tx_hash text CHECK (execution_tx_hash IS NULL OR execution_tx_hash ~ '^0x[0-9a-f]{64}$'),
    block_number bigint CHECK (block_number IS NULL OR block_number >= 0),
    block_hash text CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
    confirmations integer NOT NULL CHECK (confirmations >= 0),
    canonical boolean NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    observed_at timestamptz NOT NULL,
    UNIQUE (policy_version, evidence_hash),
    CHECK (
        (event_type = 'FINAL' AND canonical AND safe_tx_hash IS NOT NULL
            AND execution_tx_hash IS NOT NULL AND block_number IS NOT NULL
            AND block_hash IS NOT NULL AND confirmations >= 15)
        OR (event_type = 'REORGED' AND NOT canonical)
        OR (draft_id IS NULL AND transition_id LIKE 'migration:policy-final:%'
            AND event_type = 'FINAL' AND canonical)
    )
);

INSERT INTO core.policy_publication_transitions (
    transition_id, policy_version, event_type, safe_tx_hash, confirmations,
    canonical, evidence_hash, evidence, observed_at
)
SELECT
    'migration:policy-final:' || policy_version,
    policy_version,
    'FINAL',
    safe_tx_hash,
    15,
    true,
    '0x' || lpad(to_hex(policy_version), 64, '0'),
    jsonb_build_object(
        'source', 'migration',
        'policyVersion', policy_version,
        'safeTxHash', safe_tx_hash,
        'confirmations', 15,
        'canonical', true
    ),
    COALESCE(effective_from, created_at)
FROM core.policy_snapshots;

CREATE VIEW core.canonical_policy_publications AS
WITH latest AS (
    SELECT DISTINCT ON (policy_version)
        policy_version, event_type, canonical, transition_id, observed_at
    FROM core.policy_publication_transitions
    ORDER BY policy_version, transition_sequence DESC
)
SELECT snapshot.*, latest.transition_id AS publication_transition_id,
       latest.observed_at AS publication_observed_at
FROM core.policy_snapshots snapshot
JOIN latest USING (policy_version)
WHERE latest.event_type = 'FINAL' AND latest.canonical;

CREATE TABLE core.cms_entries (
    entry_id text PRIMARY KEY,
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,95}$'),
    content_type text NOT NULL CHECK (content_type IN (
        'BANNER', 'RECOMMENDATION', 'SPLASH', 'CAMPAIGN_POPUP', 'SECKILL_RULES',
        'FAQ', 'SERVICE_AGREEMENT', 'PRIVACY', 'ABOUT', 'RELEASE_ANNOUNCEMENT',
        'UPDATE_NOTICE', 'CONTRACT_NOTICE'
    )),
    placement text NOT NULL CHECK (length(placement) BETWEEN 1 AND 96),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL
);

CREATE TABLE core.cms_versions (
    version_id text PRIMARY KEY,
    entry_id text NOT NULL REFERENCES core.cms_entries(entry_id),
    version integer NOT NULL CHECK (version > 0),
    locale text NOT NULL CHECK (locale ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
    content_format text NOT NULL CHECK (content_format IN ('STRUCTURED_RICH_TEXT', 'STRUCTURED_CAMPAIGN')),
    source_content jsonb NOT NULL CHECK (jsonb_typeof(source_content) = 'object'),
    sanitized_content jsonb NOT NULL CHECK (jsonb_typeof(sanitized_content) = 'object'),
    content_hash text NOT NULL CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
    audience jsonb NOT NULL CHECK (jsonb_typeof(audience) = 'object'),
    starts_at timestamptz,
    ends_at timestamptz,
    frequency_cap integer CHECK (frequency_cap IS NULL OR frequency_cap > 0),
    policy_version bigint CHECK (policy_version IS NULL OR policy_version > 0),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (entry_id, version),
    UNIQUE (created_by, idempotency_key),
    CHECK (ends_at IS NULL OR starts_at IS NOT NULL),
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE core.cms_publication_events (
    event_id text PRIMARY KEY,
    publication_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    entry_id text NOT NULL REFERENCES core.cms_entries(entry_id),
    active_version_id text NOT NULL REFERENCES core.cms_versions(version_id),
    event_type text NOT NULL CHECK (event_type IN ('PUBLISHED', 'ROLLED_BACK')),
    previous_version_id text REFERENCES core.cms_versions(version_id),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (entry_id, evidence_hash),
    CHECK (active_version_id IS DISTINCT FROM previous_version_id)
);

CREATE VIEW core.current_cms_publications AS
SELECT DISTINCT ON (event.entry_id)
    event.entry_id, event.active_version_id, event.event_type, event.created_at,
    version.version, version.locale, version.content_format,
    version.sanitized_content, version.content_hash, version.audience,
    version.starts_at, version.ends_at, version.frequency_cap, version.policy_version
FROM core.cms_publication_events event
JOIN core.cms_versions version ON version.version_id = event.active_version_id
ORDER BY event.entry_id, event.publication_sequence DESC;

CREATE TABLE core.notification_endpoints (
    endpoint_id text PRIMARY KEY,
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    merchant_id text REFERENCES core.merchants(merchant_id),
    region_code text,
    channel text NOT NULL CHECK (channel IN ('IN_APP', 'SMS', 'EMAIL', 'PUSH')),
    provider text NOT NULL CHECK (provider IN (
        'CORE', 'ALIYUN_SMS', 'TENCENT_SMS', 'SMTP', 'FIREBASE', 'JPUSH'
    )),
    endpoint_reference text NOT NULL CHECK (endpoint_reference ~ '^(?:vault|secret|recipient)://[^[:space:]]+$'),
    topics jsonb NOT NULL CHECK (jsonb_typeof(topics) = 'array'),
    state text NOT NULL CHECK (state IN ('ACTIVE', 'PAUSED', 'REVOKED')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (wallet_address, channel, provider)
);

CREATE TABLE core.notification_campaigns (
    campaign_id text PRIMARY KEY,
    topic text NOT NULL CHECK (topic IN ('ANNOUNCEMENT', 'MAINTENANCE', 'ACTIVITY')),
    audience jsonb NOT NULL CHECK (jsonb_typeof(audience) = 'object'),
    message jsonb NOT NULL CHECK (jsonb_typeof(message) = 'object'),
    content_hash text NOT NULL CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
    cms_version_id text REFERENCES core.cms_versions(version_id),
    starts_at timestamptz,
    ends_at timestamptz,
    state text NOT NULL CHECK (state IN ('DRAFT', 'PUBLISHED', 'CANCELLED')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    published_at timestamptz,
    CHECK ((state = 'PUBLISHED') = (published_at IS NOT NULL)),
    CHECK (ends_at IS NULL OR (starts_at IS NOT NULL AND ends_at > starts_at)),
    UNIQUE (created_by, idempotency_key)
);

CREATE TABLE core.notification_campaign_events (
    campaign_event_id text PRIMARY KEY,
    campaign_id text NOT NULL REFERENCES core.notification_campaigns(campaign_id),
    event_type text NOT NULL CHECK (event_type IN ('CREATED', 'PUBLISHED', 'CANCELLED')),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (campaign_id, evidence_hash)
);

CREATE TABLE core.notification_messages (
    message_id text PRIMARY KEY,
    source_event_id text NOT NULL,
    source_event_type text NOT NULL,
    recipient_wallet text NOT NULL CHECK (recipient_wallet ~ '^0x[0-9a-f]{40}$'),
    topic text NOT NULL,
    template_data jsonb NOT NULL CHECK (jsonb_typeof(template_data) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (source_event_id, recipient_wallet, topic)
);

CREATE TABLE core.notification_deliveries (
    delivery_id text PRIMARY KEY,
    message_id text NOT NULL REFERENCES core.notification_messages(message_id),
    endpoint_id text NOT NULL REFERENCES core.notification_endpoints(endpoint_id),
    channel text NOT NULL CHECK (channel IN ('IN_APP', 'SMS', 'EMAIL', 'PUSH')),
    provider text NOT NULL CHECK (provider IN (
        'CORE', 'ALIYUN_SMS', 'TENCENT_SMS', 'SMTP', 'FIREBASE', 'JPUSH'
    )),
    endpoint_reference text NOT NULL,
    state text NOT NULL CHECK (state IN (
        'PENDING', 'PROCESSING', 'DELIVERED', 'RETRY', 'CONFIGURATION_REQUIRED', 'DEAD_LETTER'
    )),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamptz NOT NULL,
    locked_by text,
    locked_until timestamptz,
    provider_message_id text,
    last_error_code text,
    delivered_at timestamptz,
    UNIQUE (message_id, endpoint_id)
);

CREATE INDEX notification_delivery_ready_idx
    ON core.notification_deliveries (available_at, delivery_id)
    WHERE state IN ('PENDING', 'RETRY');

CREATE TABLE core.notification_source_consumptions (
    source_event_id text PRIMARY KEY,
    source_event_type text NOT NULL,
    consumed_at timestamptz NOT NULL
);

CREATE TABLE core.system_config_versions (
    config_version_id text PRIMARY KEY,
    config_key text NOT NULL CHECK (config_key IN (
        'BUSINESS', 'FREIGHT', 'RPC', 'NPL_QUOTE', 'GAS', 'CHAIN', 'INTEGRATIONS'
    )),
    version integer NOT NULL CHECK (version > 0),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
    effective_from timestamptz NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    created_by text NOT NULL CHECK (created_by ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (config_key, version),
    UNIQUE (config_key, payload_hash),
    UNIQUE (created_by, idempotency_key)
);

CREATE TABLE core.system_config_publication_events (
    event_id text PRIMARY KEY,
    publication_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    config_key text NOT NULL,
    active_config_version_id text NOT NULL REFERENCES core.system_config_versions(config_version_id),
    previous_config_version_id text REFERENCES core.system_config_versions(config_version_id),
    action_digest text NOT NULL UNIQUE CHECK (action_digest ~ '^0x[0-9a-f]{64}$'),
    secondary_signer text NOT NULL CHECK (secondary_signer ~ '^0x[0-9a-f]{40}$'),
    safe_address text NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
    safe_tx_hash text NOT NULL CHECK (safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    CHECK (active_config_version_id IS DISTINCT FROM previous_config_version_id)
);

CREATE VIEW core.current_system_config AS
SELECT DISTINCT ON (event.config_key)
    event.config_key, version.config_version_id, version.version, version.payload,
    version.payload_hash, version.effective_from, event.created_at AS published_at
FROM core.system_config_publication_events event
JOIN core.system_config_versions version ON version.config_version_id = event.active_config_version_id
WHERE version.effective_from <= clock_timestamp()
ORDER BY event.config_key, event.publication_sequence DESC;

CREATE TABLE core.audit_outbox_events (
    source_event_id text PRIMARY KEY,
    stream_name text NOT NULL CHECK (stream_name IN (
        'financial', 'governance', 'authentication', 'operational', 'backup'
    )),
    evidence_profile text NOT NULL CHECK (evidence_profile IN (
        'RBAC', 'AUTHORIZATION', 'SIGNED_OFFCHAIN', 'SAFE_APPROVED',
        'CHAIN_OBSERVED', 'CHAIN_FINAL', 'SYSTEM'
    )),
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
    authorization_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(authorization_evidence) = 'object'),
    state text NOT NULL CHECK (state IN ('PENDING', 'PROCESSING', 'DELIVERED', 'RETRY', 'DEAD_LETTER')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamptz NOT NULL,
    locked_by text,
    locked_until timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL,
    delivered_at timestamptz,
    CHECK (
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
            AND payload->>'evidenceHash' ~ '^0x[0-9a-fA-F]{64}$')
    )
);

CREATE INDEX audit_outbox_ready_idx
    ON core.audit_outbox_events (available_at, created_at)
    WHERE state IN ('PENDING', 'RETRY');

CREATE TABLE core.operations_metric_snapshots (
    snapshot_id text PRIMARY KEY,
    component text NOT NULL CHECK (component IN (
        'HOST', 'REDIS', 'MQ', 'DATABASE', 'HTTP', 'PAYMENT', 'FULFILLMENT',
        'RPC_PRIMARY', 'RPC_FALLBACK', 'EXPLORER'
    )),
    metric_name text NOT NULL,
    unit text NOT NULL CHECK (unit IN ('PERCENT', 'BYTES', 'COUNT', 'MILLISECONDS', 'BLOCK', 'PER_SECOND')),
    metric_value numeric,
    status text NOT NULL CHECK (status IN (
        'HEALTHY', 'WARNING', 'CRITICAL', 'UNAVAILABLE', 'CONFIGURATION_REQUIRED'
    )),
    window_started_at timestamptz NOT NULL,
    window_ended_at timestamptz NOT NULL,
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    observed_at timestamptz NOT NULL,
    CHECK (window_ended_at >= window_started_at),
    CHECK ((status IN ('UNAVAILABLE', 'CONFIGURATION_REQUIRED')) = (metric_value IS NULL))
);

CREATE INDEX operations_metric_recent_idx
    ON core.operations_metric_snapshots (component, metric_name, observed_at DESC);

CREATE TABLE core.operations_alert_events (
    alert_event_id text PRIMARY KEY,
    alert_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    alert_key text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('OPENED', 'ACKNOWLEDGED', 'RECOVERED')),
    severity text NOT NULL CHECK (severity IN ('WARNING', 'CRITICAL')),
    snapshot_id text NOT NULL REFERENCES core.operations_metric_snapshots(snapshot_id),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text CHECK (actor_wallet IS NULL OR actor_wallet ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (alert_key, evidence_hash),
    CHECK ((event_type = 'ACKNOWLEDGED') = (actor_wallet IS NOT NULL))
);

CREATE VIEW core.current_operations_alerts AS
SELECT DISTINCT ON (alert_key) *
FROM core.operations_alert_events
ORDER BY alert_key, alert_sequence DESC;

ALTER TABLE core.provider_readiness
    DROP CONSTRAINT provider_readiness_provider_check,
    ADD CONSTRAINT provider_readiness_provider_check CHECK (provider IN (
        'AMAP', 'KUAIDI100', 'CAINIAO', 'FEIE', 'YILIANYUN', 'BNM',
        'ALIYUN_SMS', 'TENCENT_SMS', 'ALIYUN_OSS', 'SMTP', 'FIREBASE', 'JPUSH',
        'RPC_PRIMARY', 'RPC_FALLBACK', 'EXPLORER'
    ));

CREATE FUNCTION core.protect_policy_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state IN ('SECONDARY_SIGNED', 'SAFE_PROPOSED', 'FINALITY_PENDING', 'REORGED', 'PUBLISHED')
       AND (
           NEW.next_policy_version IS DISTINCT FROM OLD.next_policy_version
           OR NEW.base_policy_version IS DISTINCT FROM OLD.base_policy_version
           OR NEW.payload IS DISTINCT FROM OLD.payload
           OR NEW.validation_errors IS DISTINCT FROM OLD.validation_errors
           OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
           OR NEW.operations_hash IS DISTINCT FROM OLD.operations_hash
           OR NEW.publication_digest IS DISTINCT FROM OLD.publication_digest
           OR NEW.publication_nonce IS DISTINCT FROM OLD.publication_nonce
           OR NEW.publication_deadline IS DISTINCT FROM OLD.publication_deadline
           OR NEW.secondary_signer IS DISTINCT FROM OLD.secondary_signer
           OR NEW.secondary_signature IS DISTINCT FROM OLD.secondary_signature
           OR NEW.secondary_signature_hash IS DISTINCT FROM OLD.secondary_signature_hash
           OR NEW.safe_address IS DISTINCT FROM OLD.safe_address
           OR NEW.safe_calldata IS DISTINCT FROM OLD.safe_calldata
           OR NEW.safe_calldata_hash IS DISTINCT FROM OLD.safe_calldata_hash
       )
    THEN
        RAISE EXCEPTION 'ImmutablePolicyApproval' USING ERRCODE = 'P0001';
    END IF;
    IF NOT (
        (OLD.state IN ('DRAFT', 'DECISION_BLOCKED') AND NEW.state IN ('DRAFT', 'DECISION_BLOCKED', 'SECONDARY_SIGNED', 'REJECTED'))
        OR (OLD.state = 'SECONDARY_SIGNED' AND NEW.state IN ('SAFE_PROPOSED', 'REJECTED'))
        OR (OLD.state = 'SAFE_PROPOSED' AND NEW.state IN ('FINALITY_PENDING', 'REORGED', 'REJECTED'))
        OR (OLD.state = 'FINALITY_PENDING' AND NEW.state IN ('PUBLISHED', 'REORGED'))
        OR (OLD.state = 'REORGED' AND NEW.state IN ('SAFE_PROPOSED', 'FINALITY_PENDING', 'PUBLISHED', 'REJECTED'))
        OR (OLD.state = 'PUBLISHED' AND NEW.state = 'REORGED')
        OR OLD.state = NEW.state
    ) THEN
        RAISE EXCEPTION 'InvalidPolicyDraftTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER policy_drafts_protected
    BEFORE UPDATE ON core.policy_drafts
    FOR EACH ROW EXECUTE FUNCTION core.protect_policy_draft();

CREATE TRIGGER policy_publication_transitions_append_only
    BEFORE UPDATE OR DELETE ON core.policy_publication_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER policy_draft_transitions_append_only
    BEFORE UPDATE OR DELETE ON core.policy_draft_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER cms_entries_no_delete
    BEFORE DELETE ON core.cms_entries
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER cms_versions_immutable
    BEFORE UPDATE OR DELETE ON core.cms_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER cms_publication_events_immutable
    BEFORE UPDATE OR DELETE ON core.cms_publication_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER notification_campaigns_no_delete
    BEFORE DELETE ON core.notification_campaigns
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER notification_campaign_events_immutable
    BEFORE UPDATE OR DELETE ON core.notification_campaign_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER notification_messages_immutable
    BEFORE UPDATE OR DELETE ON core.notification_messages
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER notification_deliveries_no_delete
    BEFORE DELETE ON core.notification_deliveries
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER notification_source_consumptions_immutable
    BEFORE UPDATE OR DELETE ON core.notification_source_consumptions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER system_config_versions_immutable
    BEFORE UPDATE OR DELETE ON core.system_config_versions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER system_config_publication_events_immutable
    BEFORE UPDATE OR DELETE ON core.system_config_publication_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER audit_outbox_no_delete
    BEFORE DELETE ON core.audit_outbox_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER operations_metric_snapshots_immutable
    BEFORE UPDATE OR DELETE ON core.operations_metric_snapshots
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER operations_alert_events_immutable
    BEFORE UPDATE OR DELETE ON core.operations_alert_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
