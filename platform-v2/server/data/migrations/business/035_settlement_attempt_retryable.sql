ALTER TABLE core.settlement_transfer_attempts
    DROP CONSTRAINT settlement_transfer_attempts_state_check;

ALTER TABLE core.settlement_transfer_attempts
    ADD CONSTRAINT settlement_transfer_attempts_state_check CHECK (state IN (
        'LEASED', 'SUBMITTED', 'MINED', 'SETTLED', 'REPLACED',
        'FAILED', 'RETRYABLE', 'REORGED', 'QUARANTINED'
    ));
