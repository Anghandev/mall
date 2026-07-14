ALTER TABLE core.ledger_accounts ADD COLUMN subtype text;

UPDATE core.ledger_accounts
SET subtype = CASE split_part(account_id, ':', 2)
    WHEN 'genesis' THEN 'GENESIS'
    WHEN 'directReferral' THEN 'DIRECT_REFERRAL'
    WHEN 'district' THEN 'DISTRICT'
    WHEN 'city' THEN 'CITY'
    WHEN 'province' THEN 'PROVINCE'
    WHEN 'region' THEN 'REGION'
    WHEN 'operations' THEN 'OPERATIONS'
    WHEN 'roundingRemainder' THEN 'ROUNDING_REMAINDER'
    ELSE NULL
END
WHERE purpose = 'REWARD_LIABILITY';

ALTER TABLE core.ledger_accounts ADD CONSTRAINT ledger_accounts_reward_subtype_check
    CHECK (
        (purpose = 'REWARD_LIABILITY' AND subtype IN (
            'GENESIS', 'DIRECT_REFERRAL', 'DISTRICT', 'CITY',
            'PROVINCE', 'REGION', 'OPERATIONS', 'ROUNDING_REMAINDER'
        ))
        OR (purpose <> 'REWARD_LIABILITY' AND subtype IS NULL)
    );

CREATE TABLE core.seckill_relay_events (
    cursor bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    relay_event_key text PRIMARY KEY,
    payment_event_key text NOT NULL REFERENCES core.payment_events(event_key),
    session_id text NOT NULL REFERENCES core.seckill_sessions(session_id),
    order_id text NOT NULL UNIQUE REFERENCES core.orders(order_id),
    buyer_wallet text NOT NULL CHECK (buyer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
    log_index bigint NOT NULL CHECK (log_index >= 0),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
    previous_relay_deadline timestamptz NOT NULL,
    relay_deadline timestamptz NOT NULL,
    canonical boolean NOT NULL DEFAULT true,
    finalized boolean NOT NULL DEFAULT false,
    finalized_at timestamptz,
    replacement_block_hash text CHECK (
        replacement_block_hash IS NULL OR replacement_block_hash ~ '^0x[0-9a-fA-F]{64}$'
    ),
    replaced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (relay_deadline >= previous_relay_deadline),
    CHECK (finalized = (finalized_at IS NOT NULL)),
    CHECK (canonical OR replacement_block_hash IS NOT NULL)
);

CREATE UNIQUE INDEX seckill_relay_events_chain_identity_idx
    ON core.seckill_relay_events (block_hash, transaction_hash, log_index);

CREATE INDEX seckill_relay_events_session_cursor_idx
    ON core.seckill_relay_events (session_id, block_number, log_index)
    WHERE canonical;
