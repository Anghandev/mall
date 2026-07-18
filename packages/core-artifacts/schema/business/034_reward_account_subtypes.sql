ALTER TABLE core.ledger_accounts
    DROP CONSTRAINT ledger_accounts_owner_type_owner_id_asset_purpose_key;

CREATE UNIQUE INDEX ledger_accounts_owner_identity_without_subtype_key
    ON core.ledger_accounts (owner_type, owner_id, asset, purpose)
    WHERE subtype IS NULL;

CREATE UNIQUE INDEX ledger_accounts_owner_identity_with_subtype_key
    ON core.ledger_accounts (owner_type, owner_id, asset, purpose, subtype)
    WHERE subtype IS NOT NULL;
