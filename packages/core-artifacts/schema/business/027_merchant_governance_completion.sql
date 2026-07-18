ALTER TABLE core.system_config_versions
    DROP CONSTRAINT system_config_versions_config_key_check,
    ADD CONSTRAINT system_config_versions_config_key_check CHECK (config_key IN (
        'BUSINESS', 'FREIGHT', 'RPC', 'NPL_QUOTE', 'GAS', 'CHAIN', 'INTEGRATIONS',
        'MERCHANT_LEVELS'
    ));
