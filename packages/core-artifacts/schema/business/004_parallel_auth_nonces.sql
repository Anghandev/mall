ALTER TABLE core.auth_nonces DROP CONSTRAINT auth_nonces_pkey;
ALTER TABLE core.auth_nonces ADD PRIMARY KEY (nonce_hash);

CREATE INDEX auth_nonces_wallet_active_idx
    ON core.auth_nonces (wallet_address, expires_at)
    WHERE consumed_at IS NULL;
