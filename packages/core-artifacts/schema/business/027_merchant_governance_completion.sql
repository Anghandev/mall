ALTER TABLE core.system_config_versions
    DROP CONSTRAINT system_config_versions_config_key_check,
    ADD CONSTRAINT system_config_versions_config_key_check CHECK (config_key IN (
        'BUSINESS', 'FREIGHT', 'RPC', 'ORACLE', 'GAS', 'CHAIN', 'INTEGRATIONS',
        'MERCHANT_LEVELS'
    ));

ALTER TABLE core.merchant_review_actions
    DROP CONSTRAINT merchant_review_actions_action_kind_check,
    ADD CONSTRAINT merchant_review_actions_action_kind_check CHECK (action_kind IN (
        'APPROVE', 'REJECT', 'BLACKLIST', 'CHANGE_SETTLEMENT_WALLET'
    )),
    ADD COLUMN previous_settlement_wallet text CHECK (
        previous_settlement_wallet IS NULL OR previous_settlement_wallet ~ '^0x[0-9a-fA-F]{40}$'
    ),
    ADD COLUMN proposed_settlement_wallet text CHECK (
        proposed_settlement_wallet IS NULL OR proposed_settlement_wallet ~ '^0x[0-9a-fA-F]{40}$'
    ),
    ADD COLUMN wallet_change_applied_at timestamptz,
    ADD CONSTRAINT merchant_review_actions_wallet_change_check CHECK (
        (
            action_kind = 'CHANGE_SETTLEMENT_WALLET'
            AND from_status = 'APPROVED'
            AND to_status = 'APPROVED'
            AND previous_settlement_wallet IS NOT NULL
            AND proposed_settlement_wallet IS NOT NULL
            AND previous_settlement_wallet <> proposed_settlement_wallet
        ) OR (
            action_kind <> 'CHANGE_SETTLEMENT_WALLET'
            AND previous_settlement_wallet IS NULL
            AND proposed_settlement_wallet IS NULL
            AND wallet_change_applied_at IS NULL
        )
    ),
    ADD CONSTRAINT merchant_review_actions_wallet_applied_check CHECK (
        wallet_change_applied_at IS NULL
        OR (action_kind = 'CHANGE_SETTLEMENT_WALLET' AND state = 'PUBLISHED')
    );

CREATE OR REPLACE FUNCTION core.protect_merchant_review_action() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ImmutableRecord' USING ERRCODE = 'P0001';
    END IF;

    IF OLD.state = 'PUBLISHED'
        AND OLD.action_kind = 'CHANGE_SETTLEMENT_WALLET'
        AND OLD.wallet_change_applied_at IS NULL
        AND NEW.state = 'PUBLISHED'
        AND NEW.wallet_change_applied_at IS NOT NULL
        AND NEW.action_id IS NOT DISTINCT FROM OLD.action_id
        AND NEW.merchant_id IS NOT DISTINCT FROM OLD.merchant_id
        AND NEW.action_kind IS NOT DISTINCT FROM OLD.action_kind
        AND NEW.from_status IS NOT DISTINCT FROM OLD.from_status
        AND NEW.to_status IS NOT DISTINCT FROM OLD.to_status
        AND NEW.application_version IS NOT DISTINCT FROM OLD.application_version
        AND NEW.policy_version IS NOT DISTINCT FROM OLD.policy_version
        AND NEW.reason_code IS NOT DISTINCT FROM OLD.reason_code
        AND NEW.old_value_hash IS NOT DISTINCT FROM OLD.old_value_hash
        AND NEW.new_value_hash IS NOT DISTINCT FROM OLD.new_value_hash
        AND NEW.approval_nonce IS NOT DISTINCT FROM OLD.approval_nonce
        AND NEW.approval_deadline IS NOT DISTINCT FROM OLD.approval_deadline
        AND NEW.secondary_signer IS NOT DISTINCT FROM OLD.secondary_signer
        AND NEW.secondary_signature_hash IS NOT DISTINCT FROM OLD.secondary_signature_hash
        AND NEW.action_digest IS NOT DISTINCT FROM OLD.action_digest
        AND NEW.governance_safe_address IS NOT DISTINCT FROM OLD.governance_safe_address
        AND NEW.safe_tx_hash IS NOT DISTINCT FROM OLD.safe_tx_hash
        AND NEW.approval_evidence_hash IS NOT DISTINCT FROM OLD.approval_evidence_hash
        AND NEW.actor_wallet IS NOT DISTINCT FROM OLD.actor_wallet
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.request_hash IS NOT DISTINCT FROM OLD.request_hash
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.previous_settlement_wallet IS NOT DISTINCT FROM OLD.previous_settlement_wallet
        AND NEW.proposed_settlement_wallet IS NOT DISTINCT FROM OLD.proposed_settlement_wallet
    THEN
        RETURN NEW;
    END IF;

    IF NEW.action_id IS DISTINCT FROM OLD.action_id
        OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
        OR NEW.action_kind IS DISTINCT FROM OLD.action_kind
        OR NEW.from_status IS DISTINCT FROM OLD.from_status
        OR NEW.to_status IS DISTINCT FROM OLD.to_status
        OR NEW.application_version IS DISTINCT FROM OLD.application_version
        OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
        OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
        OR NEW.old_value_hash IS DISTINCT FROM OLD.old_value_hash
        OR NEW.new_value_hash IS DISTINCT FROM OLD.new_value_hash
        OR NEW.approval_nonce IS DISTINCT FROM OLD.approval_nonce
        OR NEW.approval_deadline IS DISTINCT FROM OLD.approval_deadline
        OR NEW.governance_safe_address IS DISTINCT FROM OLD.governance_safe_address
        OR NEW.actor_wallet IS DISTINCT FROM OLD.actor_wallet
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.previous_settlement_wallet IS DISTINCT FROM OLD.previous_settlement_wallet
        OR NEW.proposed_settlement_wallet IS DISTINCT FROM OLD.proposed_settlement_wallet
        OR NEW.wallet_change_applied_at IS DISTINCT FROM OLD.wallet_change_applied_at
        OR OLD.state <> 'DRAFT'
        OR NEW.state NOT IN ('PUBLISHED', 'EXPIRED')
    THEN
        RAISE EXCEPTION 'ImmutableMerchantReviewAction' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.protect_approved_settlement_wallet() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.settlement_wallet IS DISTINCT FROM OLD.settlement_wallet THEN
        IF OLD.status <> 'APPROVED'
            OR NEW.status <> 'APPROVED'
            OR NOT EXISTS (
                SELECT 1
                FROM core.merchant_review_actions action
                WHERE action.merchant_id = OLD.merchant_id
                  AND action.action_kind = 'CHANGE_SETTLEMENT_WALLET'
                  AND action.state = 'PUBLISHED'
                  AND action.previous_settlement_wallet = lower(OLD.settlement_wallet)
                  AND action.proposed_settlement_wallet = lower(NEW.settlement_wallet)
                  AND action.wallet_change_applied_at IS NULL
            )
        THEN
            RAISE EXCEPTION 'GovernedWalletMigrationRequired' USING ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
