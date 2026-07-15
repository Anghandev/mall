ALTER TABLE core.coverage_breaker_actions
    ADD COLUMN safe_nonce numeric(78, 0) CHECK (
        safe_nonce IS NULL OR (
            safe_nonce >= 0
            AND safe_nonce < 115792089237316195423570985008687907853269984665640564039457584007913129639936
        )
    );

ALTER TABLE core.coverage_breaker_actions
    ADD CONSTRAINT coverage_breaker_safe_nonce_state CHECK (
        (state IN ('PENDING_PROPOSAL', 'SUPERSEDED') AND safe_nonce IS NULL)
        OR (state NOT IN ('PENDING_PROPOSAL', 'SUPERSEDED') AND safe_nonce IS NOT NULL)
    );

CREATE UNIQUE INDEX coverage_breaker_safe_nonce_idx
    ON core.coverage_breaker_actions (governance_safe_address, safe_nonce)
    WHERE safe_nonce IS NOT NULL;

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
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (
           NEW.safe_nonce IS DISTINCT FROM OLD.safe_nonce
           AND NOT (
               OLD.state = 'PENDING_PROPOSAL'
               AND OLD.safe_nonce IS NULL
               AND NEW.state = 'SAFE_PROPOSED'
               AND NEW.safe_nonce IS NOT NULL
           )
       ) THEN
        RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
