ALTER TABLE core.evidence_envelopes
    DROP CONSTRAINT evidence_envelopes_action_type_check;

ALTER TABLE core.evidence_envelopes
    ADD CONSTRAINT evidence_envelopes_action_type_check CHECK (action_type IN (
        'REQUEST_EXCHANGE', 'REQUEST_DELAY', 'CONFIRM_RECEIPT',
        'OPEN_ARBITRATION', 'VERIFY_PICKUP', 'REQUEST_FORCED_RECEIPT',
        'RECORD_SHIPMENT', 'RECORD_DELIVERY'
    ));
