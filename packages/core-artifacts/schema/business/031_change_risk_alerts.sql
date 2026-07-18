ALTER TABLE core.risk_observations
    DROP CONSTRAINT risk_observations_signal_type_check,
    DROP CONSTRAINT risk_observations_source_type_check,
    DROP CONSTRAINT risk_observations_check;

ALTER TABLE core.risk_observations
    ADD CONSTRAINT risk_observations_signal_type_check CHECK (signal_type IN (
        'HIGH_GAS', 'WALLET_CONTEXT', 'ORDER_CANCELLATION',
        'ADDRESS_CHANGE', 'PICKUP_STORE_CHANGE'
    )),
    ADD CONSTRAINT risk_observations_source_type_check CHECK (source_type IN (
        'CHAIN_MONITOR', 'EDGE_AUTH', 'ORDER_SERVICE',
        'ACCOUNT_SERVICE', 'FULFILLMENT_TARGET_SERVICE'
    )),
    ADD CONSTRAINT risk_observations_check CHECK (
        (signal_type = 'HIGH_GAS' AND source_type = 'CHAIN_MONITOR'
            AND tx_hash IS NOT NULL AND gas_price_wei IS NOT NULL)
        OR (signal_type = 'WALLET_CONTEXT' AND source_type = 'EDGE_AUTH'
            AND (ip_hash IS NOT NULL OR device_hash IS NOT NULL))
        OR (signal_type = 'ORDER_CANCELLATION' AND source_type = 'ORDER_SERVICE'
            AND resource_id IS NOT NULL)
        OR (signal_type = 'ADDRESS_CHANGE' AND source_type = 'ACCOUNT_SERVICE'
            AND resource_id IS NOT NULL)
        OR (signal_type = 'PICKUP_STORE_CHANGE' AND source_type = 'FULFILLMENT_TARGET_SERVICE'
            AND resource_id IS NOT NULL)
    );
