ALTER TABLE core.evidence_envelopes
    ADD COLUMN encrypted_tracking_number bytea,
    ADD COLUMN tracking_iv bytea,
    ADD COLUMN tracking_tag bytea,
    ADD CONSTRAINT evidence_envelopes_tracking_cipher_check CHECK (
        (purpose <> 'SHIPMENT_TRACKING'
            AND encrypted_tracking_number IS NULL
            AND tracking_iv IS NULL
            AND tracking_tag IS NULL)
        OR (purpose = 'SHIPMENT_TRACKING'
            AND encrypted_tracking_number IS NOT NULL
            AND octet_length(encrypted_tracking_number) > 0
            AND octet_length(tracking_iv) = 12
            AND octet_length(tracking_tag) = 16)
    );

ALTER TABLE core.account_write_commands
    DROP CONSTRAINT account_write_commands_command_type_check,
    ADD CONSTRAINT account_write_commands_command_type_check CHECK (command_type IN (
        'BUYER_PROFILE_UPDATE', 'BUYER_ADDRESS_CREATE', 'BUYER_ADDRESS_UPDATE',
        'BUYER_ADDRESS_DELETE', 'BUYER_ADDRESS_SET_DEFAULT', 'MERCHANT_PROFILE_UPDATE',
        'MERCHANT_AUDIT_EXPORT', 'MERCHANT_ORDER_EXPORT'
    ));
