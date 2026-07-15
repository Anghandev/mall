ALTER TABLE audit.entries
    ADD COLUMN merchant_id text;

CREATE INDEX audit_entries_merchant_idx
    ON audit.entries (merchant_id, created_at DESC, entry_id DESC)
    WHERE merchant_id IS NOT NULL;
