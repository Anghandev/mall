ALTER TABLE core.payment_quote_legs
    ADD COLUMN product_usdt_payment_amount numeric(78, 0) NOT NULL CHECK (product_usdt_payment_amount > 0),
    ADD COLUMN platform_service_fee_usdt numeric(78, 0) NOT NULL CHECK (platform_service_fee_usdt >= 0),
    ADD COLUMN custody_product_usdt numeric(78, 0) NOT NULL CHECK (custody_product_usdt > 0),
    ADD COLUMN freight_usdt numeric(78, 0) NOT NULL CHECK (freight_usdt >= 0),
    ADD COLUMN usdt_payment_amount numeric(78, 0) NOT NULL CHECK (usdt_payment_amount > 0),
    ADD CONSTRAINT payment_quote_legs_usdt_split_check CHECK (
        platform_service_fee_usdt + custody_product_usdt = product_usdt_payment_amount
        AND product_usdt_payment_amount + freight_usdt = usdt_payment_amount
    );

ALTER TABLE core.ledger_accounts
    DROP CONSTRAINT ledger_accounts_purpose_check;

ALTER TABLE core.ledger_accounts
    ADD CONSTRAINT ledger_accounts_purpose_check CHECK (purpose IN (
        'SAFE_ASSET', 'PAYMENT_CLEARING', 'BURN', 'MERCHANT_RECEIVABLE',
        'MERCHANT_FREIGHT_RECEIVABLE', 'PLATFORM_SERVICE_FEE_REVENUE',
        'CONCESSION', 'POLICY_ALLOCATION', 'SECKILL_PRIZE_LIABILITY',
        'NODE_REWARD_POOL', 'REWARD_RESERVE_POOL',
        'REWARD_LIABILITY', 'BNM_ISSUANCE', 'BNM_LIABILITY',
        'GUARANTEE_ASSET', 'GUARANTEE_LIABILITY', 'MERCHANT_DEBT_RECEIVABLE',
        'TAKEOVER_PAYABLE', 'OPERATIONS_ADVANCE_ASSET',
        'OPERATIONS_REIMBURSEMENT', 'SETTLEMENT_CLEARING'
    ));
