ALTER TABLE audit.entries
    ADD CONSTRAINT audit_entries_stream_evidence_check CHECK (
        (
            stream_name IN ('financial', 'governance')
            AND signature_evidence <> '{}'::jsonb
            AND transaction_evidence <> '{}'::jsonb
        )
        OR (
            stream_name = 'authentication'
            AND signature_evidence <> '{}'::jsonb
        )
        OR (
            stream_name = 'operational'
            AND (signature_evidence <> '{}'::jsonb OR transaction_evidence <> '{}'::jsonb)
        )
        OR (
            stream_name = 'backup'
            AND (
                event_type = 'BackupEvidence'
                OR signature_evidence <> '{}'::jsonb
                OR transaction_evidence <> '{}'::jsonb
            )
        )
    );
