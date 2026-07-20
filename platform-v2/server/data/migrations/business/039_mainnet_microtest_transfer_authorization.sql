ALTER TABLE core.settlement_transfers
    ADD COLUMN authorization_mode text NOT NULL DEFAULT 'FORMAL',
    ADD COLUMN authorization_expires_at timestamptz,
    ADD COLUMN authorization_evidence_hash text;

ALTER TABLE core.settlement_transfers
    ADD CONSTRAINT settlement_transfers_authorization_mode_check
        CHECK (authorization_mode IN ('FORMAL', 'MAINNET_MICROTEST')),
    ADD CONSTRAINT settlement_transfers_authorization_evidence_check
        CHECK (
            (authorization_mode = 'FORMAL'
                AND authorization_expires_at IS NULL
                AND authorization_evidence_hash IS NULL)
            OR
            (authorization_mode = 'MAINNET_MICROTEST'
                AND authorization_expires_at IS NOT NULL
                AND authorization_evidence_hash ~ '^0x[0-9a-f]{64}$')
        );
