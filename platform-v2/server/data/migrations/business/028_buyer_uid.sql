CREATE TABLE core.buyer_accounts (
    buyer_wallet text PRIMARY KEY CHECK (buyer_wallet ~ '^0x[0-9a-f]{40}$'),
    uid bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    created_at timestamptz NOT NULL
);

CREATE TRIGGER buyer_accounts_no_update_or_delete
    BEFORE UPDATE OR DELETE ON core.buyer_accounts
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
