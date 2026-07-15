CREATE TABLE core.risk_observations (
    observation_id text PRIMARY KEY CHECK (observation_id ~ '^0x[0-9a-f]{64}$'),
    signal_type text NOT NULL CHECK (signal_type IN (
        'HIGH_GAS', 'WALLET_CONTEXT', 'ORDER_CANCELLATION'
    )),
    source_type text NOT NULL CHECK (source_type IN ('CHAIN_MONITOR', 'EDGE_AUTH', 'ORDER_SERVICE')),
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^0x[0-9a-f]{64}$'),
    device_hash text CHECK (device_hash IS NULL OR device_hash ~ '^0x[0-9a-f]{64}$'),
    resource_id text,
    tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
    gas_price_wei numeric(78, 0) CHECK (gas_price_wei IS NULL OR gas_price_wei >= 0),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL,
    CHECK (
        (signal_type = 'HIGH_GAS' AND source_type = 'CHAIN_MONITOR'
            AND tx_hash IS NOT NULL AND gas_price_wei IS NOT NULL)
        OR (signal_type = 'WALLET_CONTEXT' AND source_type = 'EDGE_AUTH'
            AND (ip_hash IS NOT NULL OR device_hash IS NOT NULL))
        OR (signal_type = 'ORDER_CANCELLATION' AND source_type = 'ORDER_SERVICE'
            AND resource_id IS NOT NULL)
    )
);

CREATE INDEX risk_observations_wallet_window_idx
    ON core.risk_observations (wallet_address, signal_type, observed_at DESC, observation_id);
CREATE INDEX risk_observations_ip_window_idx
    ON core.risk_observations (ip_hash, observed_at DESC, observation_id)
    WHERE ip_hash IS NOT NULL;
CREATE INDEX risk_observations_device_window_idx
    ON core.risk_observations (device_hash, observed_at DESC, observation_id)
    WHERE device_hash IS NOT NULL;
CREATE TRIGGER risk_observations_no_mutation
    BEFORE UPDATE OR DELETE ON core.risk_observations
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TABLE core.risk_subject_wallets (
    subject_type text NOT NULL CHECK (subject_type IN ('IP', 'DEVICE')),
    subject_hash text NOT NULL CHECK (subject_hash ~ '^0x[0-9a-f]{64}$'),
    wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
    first_observation_id text NOT NULL REFERENCES core.risk_observations(observation_id),
    latest_observation_id text NOT NULL REFERENCES core.risk_observations(observation_id),
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    PRIMARY KEY (subject_type, subject_hash, wallet_address),
    CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX risk_subject_wallets_wallet_idx
    ON core.risk_subject_wallets (wallet_address, last_seen_at DESC, subject_type, subject_hash);

CREATE TABLE core.risk_restrictions (
    restriction_id text PRIMARY KEY CHECK (restriction_id ~ '^0x[0-9a-f]{64}$'),
    subject_type text NOT NULL CHECK (subject_type IN ('WALLET', 'IP', 'DEVICE')),
    subject_value text NOT NULL,
    restriction_kind text NOT NULL CHECK (restriction_kind IN ('NEW_PAYMENT', 'BLACKLIST')),
    trigger_type text NOT NULL CHECK (trigger_type IN (
        'HIGH_GAS', 'WALLET_SWITCH', 'ORDER_CANCELLATION', 'SUBJECT_BLACKLIST', 'MANUAL'
    )),
    reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 2 AND 64),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    source_observation_id text REFERENCES core.risk_observations(observation_id),
    state text NOT NULL CHECK (state IN ('ACTIVE', 'EXPIRED', 'OVERRIDDEN')),
    starts_at timestamptz NOT NULL,
    expires_at timestamptz,
    created_by text CHECK (created_by IS NULL OR created_by ~ '^0x[0-9a-f]{40}$'),
    idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    override_by text CHECK (override_by IS NULL OR override_by ~ '^0x[0-9a-f]{40}$'),
    override_reason_code text CHECK (
        override_reason_code IS NULL OR length(override_reason_code) BETWEEN 2 AND 64
    ),
    override_evidence_hash text CHECK (
        override_evidence_hash IS NULL OR override_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    override_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (
        (subject_type = 'WALLET' AND subject_value ~ '^0x[0-9a-f]{40}$')
        OR (subject_type IN ('IP', 'DEVICE') AND subject_value ~ '^0x[0-9a-f]{64}$')
    ),
    CHECK (expires_at IS NULL OR expires_at > starts_at),
    CHECK ((trigger_type = 'MANUAL') = (created_by IS NOT NULL AND idempotency_key IS NOT NULL)),
    CHECK ((state = 'OVERRIDDEN') = (
        override_by IS NOT NULL AND override_reason_code IS NOT NULL
        AND override_evidence_hash IS NOT NULL AND override_at IS NOT NULL
    ))
);

CREATE UNIQUE INDEX risk_restrictions_manual_idempotency_idx
    ON core.risk_restrictions (created_by, idempotency_key)
    WHERE created_by IS NOT NULL;
CREATE INDEX risk_restrictions_active_subject_idx
    ON core.risk_restrictions (subject_type, subject_value, restriction_kind, starts_at DESC)
    WHERE state = 'ACTIVE';
CREATE INDEX risk_restrictions_created_idx
    ON core.risk_restrictions (created_at DESC, restriction_id DESC);

CREATE TABLE core.risk_restriction_events (
    event_id text PRIMARY KEY CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
    restriction_id text NOT NULL REFERENCES core.risk_restrictions(restriction_id),
    event_type text NOT NULL CHECK (event_type IN ('CREATED', 'EXPIRED', 'OVERRIDDEN')),
    actor_wallet text CHECK (actor_wallet IS NULL OR actor_wallet ~ '^0x[0-9a-f]{40}$'),
    reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 2 AND 64),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    occurred_at timestamptz NOT NULL
);

CREATE INDEX risk_restriction_events_restriction_idx
    ON core.risk_restriction_events (restriction_id, occurred_at, event_id);
CREATE TRIGGER risk_restriction_events_no_mutation
    BEFORE UPDATE OR DELETE ON core.risk_restriction_events
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE TABLE core.risk_appeals (
    appeal_id text PRIMARY KEY CHECK (appeal_id ~ '^0x[0-9a-f]{64}$'),
    restriction_id text NOT NULL REFERENCES core.risk_restrictions(restriction_id),
    submitted_by text NOT NULL CHECK (submitted_by ~ '^0x[0-9a-f]{40}$'),
    statement_hash text NOT NULL CHECK (statement_hash ~ '^0x[0-9a-f]{64}$'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    decided_by text CHECK (decided_by IS NULL OR decided_by ~ '^0x[0-9a-f]{40}$'),
    decision_reason_code text CHECK (
        decision_reason_code IS NULL OR length(decision_reason_code) BETWEEN 2 AND 64
    ),
    decision_evidence_hash text CHECK (
        decision_evidence_hash IS NULL OR decision_evidence_hash ~ '^0x[0-9a-f]{64}$'
    ),
    decided_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (submitted_by, idempotency_key),
    CHECK ((state = 'PENDING') = (
        decided_by IS NULL AND decision_reason_code IS NULL
        AND decision_evidence_hash IS NULL AND decided_at IS NULL
    ))
);

CREATE OR REPLACE FUNCTION core.protect_risk_restriction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.restriction_id IS DISTINCT FROM OLD.restriction_id
       OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
       OR NEW.subject_value IS DISTINCT FROM OLD.subject_value
       OR NEW.restriction_kind IS DISTINCT FROM OLD.restriction_kind
       OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
       OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
       OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
       OR NEW.source_observation_id IS DISTINCT FROM OLD.source_observation_id
       OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        OLD.state = 'ACTIVE' AND NEW.state IN ('EXPIRED', 'OVERRIDDEN')
    ) THEN
        RAISE EXCEPTION 'InvalidRiskRestrictionTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER risk_restrictions_protected
    BEFORE UPDATE ON core.risk_restrictions
    FOR EACH ROW EXECUTE FUNCTION core.protect_risk_restriction();

CREATE OR REPLACE FUNCTION core.protect_risk_appeal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.appeal_id IS DISTINCT FROM OLD.appeal_id
       OR NEW.restriction_id IS DISTINCT FROM OLD.restriction_id
       OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
       OR NEW.statement_hash IS DISTINCT FROM OLD.statement_hash
       OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        OLD.state = 'PENDING' AND NEW.state IN ('APPROVED', 'REJECTED')
    ) THEN
        RAISE EXCEPTION 'InvalidRiskAppealTransition' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER risk_appeals_protected
    BEFORE UPDATE ON core.risk_appeals
    FOR EACH ROW EXECUTE FUNCTION core.protect_risk_appeal();
