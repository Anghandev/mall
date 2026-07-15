CREATE TABLE core.coverage_breaker_actions (
    action_id text PRIMARY KEY CHECK (action_id ~ '^0x[0-9a-f]{64}$'),
    snapshot_id text NOT NULL REFERENCES core.coverage_snapshots(snapshot_id),
    policy_version bigint NOT NULL REFERENCES core.policy_snapshots(policy_version),
    action text NOT NULL CHECK (action IN ('PAUSE', 'RESUME')),
    target_paused boolean NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
    governance_safe_address text NOT NULL CHECK (governance_safe_address ~ '^0x[0-9a-f]{40}$'),
    router_address text NOT NULL CHECK (router_address ~ '^0x[0-9a-f]{40}$'),
    calldata text NOT NULL CHECK (calldata ~ '^0x[0-9a-f]+$'),
    calldata_hash text NOT NULL CHECK (calldata_hash ~ '^0x[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN (
        'PENDING_PROPOSAL', 'SAFE_PROPOSED', 'MINED', 'FINAL', 'REORGED', 'FAILED'
    )),
    safe_tx_hash text CHECK (safe_tx_hash IS NULL OR safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
    proposal_hash text CHECK (proposal_hash IS NULL OR proposal_hash ~ '^0x[0-9a-f]{64}$'),
    execution_tx_hash text CHECK (execution_tx_hash IS NULL OR execution_tx_hash ~ '^0x[0-9a-f]{64}$'),
    block_number bigint CHECK (block_number IS NULL OR block_number >= 0),
    block_hash text CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
    confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    canonical boolean,
    replaces_action_id text REFERENCES core.coverage_breaker_actions(action_id),
    actor_wallet text CHECK (actor_wallet IS NULL OR actor_wallet ~ '^0x[0-9a-f]{40}$'),
    secondary_signer text CHECK (secondary_signer IS NULL OR secondary_signer ~ '^0x[0-9a-f]{40}$'),
    secondary_signature_hash text CHECK (
        secondary_signature_hash IS NULL OR secondary_signature_hash ~ '^0x[0-9a-f]{64}$'
    ),
    approval_nonce numeric(78, 0) CHECK (approval_nonce IS NULL OR approval_nonce >= 0),
    approval_deadline timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (action = CASE WHEN target_paused THEN 'PAUSE' ELSE 'RESUME' END),
    CHECK (
        (state = 'PENDING_PROPOSAL' AND safe_tx_hash IS NULL AND proposal_hash IS NULL)
        OR (state <> 'PENDING_PROPOSAL' AND safe_tx_hash IS NOT NULL AND proposal_hash IS NOT NULL)
    ),
    CHECK (
        action = 'PAUSE'
        OR (actor_wallet IS NOT NULL AND secondary_signer IS NOT NULL
            AND secondary_signature_hash IS NOT NULL AND approval_nonce IS NOT NULL
            AND approval_deadline IS NOT NULL)
    )
);

CREATE UNIQUE INDEX coverage_breaker_one_open_target_idx
    ON core.coverage_breaker_actions (target_paused)
    WHERE state IN ('PENDING_PROPOSAL', 'SAFE_PROPOSED', 'MINED');
CREATE INDEX coverage_breaker_actions_state_idx
    ON core.coverage_breaker_actions (state, updated_at, action_id);
CREATE UNIQUE INDEX coverage_breaker_resume_approval_nonce_idx
    ON core.coverage_breaker_actions (secondary_signer, approval_nonce)
    WHERE action = 'RESUME' AND replaces_action_id IS NULL;

CREATE TABLE core.coverage_breaker_action_transitions (
    transition_id text PRIMARY KEY CHECK (transition_id ~ '^0x[0-9a-f]{64}$'),
    action_id text NOT NULL REFERENCES core.coverage_breaker_actions(action_id),
    from_state text CHECK (from_state IS NULL OR from_state IN (
        'PENDING_PROPOSAL', 'SAFE_PROPOSED', 'MINED', 'FINAL', 'REORGED', 'FAILED'
    )),
    to_state text NOT NULL CHECK (to_state IN (
        'PENDING_PROPOSAL', 'SAFE_PROPOSED', 'MINED', 'FINAL', 'REORGED', 'FAILED'
    )),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    recorded_at timestamptz NOT NULL
);

CREATE INDEX coverage_breaker_action_transitions_action_idx
    ON core.coverage_breaker_action_transitions (action_id, recorded_at, transition_id);
CREATE TRIGGER coverage_breaker_action_transitions_no_mutation
    BEFORE UPDATE OR DELETE ON core.coverage_breaker_action_transitions
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

CREATE OR REPLACE FUNCTION core.protect_coverage_breaker_action() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.action_id IS DISTINCT FROM OLD.action_id
       OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
       OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
       OR NEW.action IS DISTINCT FROM OLD.action
       OR NEW.target_paused IS DISTINCT FROM OLD.target_paused
       OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
       OR NEW.governance_safe_address IS DISTINCT FROM OLD.governance_safe_address
       OR NEW.router_address IS DISTINCT FROM OLD.router_address
       OR NEW.calldata IS DISTINCT FROM OLD.calldata
       OR NEW.calldata_hash IS DISTINCT FROM OLD.calldata_hash
       OR NEW.replaces_action_id IS DISTINCT FROM OLD.replaces_action_id
       OR NEW.actor_wallet IS DISTINCT FROM OLD.actor_wallet
       OR NEW.secondary_signer IS DISTINCT FROM OLD.secondary_signer
       OR NEW.secondary_signature_hash IS DISTINCT FROM OLD.secondary_signature_hash
       OR NEW.approval_nonce IS DISTINCT FROM OLD.approval_nonce
       OR NEW.approval_deadline IS DISTINCT FROM OLD.approval_deadline
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_breaker_actions_protected
    BEFORE UPDATE ON core.coverage_breaker_actions
    FOR EACH ROW EXECUTE FUNCTION core.protect_coverage_breaker_action();
