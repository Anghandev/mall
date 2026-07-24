ALTER TABLE core.payment_quote_legs
    DROP CONSTRAINT IF EXISTS payment_quote_legs_quote_source_evidence_check;

ALTER TABLE core.payment_quote_legs
    ADD CONSTRAINT payment_quote_legs_quote_source_evidence_check CHECK (
        quote_source_evidence IS NULL OR (
            jsonb_typeof(quote_source_evidence) = 'object'
            AND quote_source_evidence ?& ARRAY['source', 'observedBlock', 'reservesHash']
            AND quote_source_evidence ->> 'source' IN ('PRIMARY', 'FALLBACK', 'PRIMARY_FALLBACK')
            AND jsonb_typeof(quote_source_evidence -> 'observedBlock') = 'number'
            AND (quote_source_evidence ->> 'observedBlock') ~ '^[1-9][0-9]*$'
            AND (quote_source_evidence ->> 'reservesHash') ~ '^0x[0-9a-fA-F]{64}$'
        )
    );
