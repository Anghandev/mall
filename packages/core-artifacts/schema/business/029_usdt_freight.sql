ALTER TABLE core.payment_quotes
    ADD COLUMN freight_usdt numeric(78, 0) NOT NULL DEFAULT 0
        CHECK (freight_usdt >= 0);

CREATE FUNCTION core.protect_payment_quote_freight() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.freight_usdt IS DISTINCT FROM OLD.freight_usdt THEN
        RAISE EXCEPTION 'ImmutablePaymentQuoteFreight' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER payment_quotes_freight_immutable
    BEFORE UPDATE ON core.payment_quotes
    FOR EACH ROW EXECUTE FUNCTION core.protect_payment_quote_freight();

ALTER TABLE core.ledger_accounts
    DROP CONSTRAINT ledger_accounts_purpose_check;

ALTER TABLE core.ledger_accounts
    ADD CONSTRAINT ledger_accounts_purpose_check CHECK (purpose IN (
        'SAFE_ASSET', 'PAYMENT_CLEARING', 'BURN', 'MERCHANT_RECEIVABLE',
        'MERCHANT_FREIGHT_RECEIVABLE', 'CONCESSION', 'POLICY_ALLOCATION',
        'SECKILL_PRIZE_LIABILITY', 'REWARD_LIABILITY', 'BNM_ISSUANCE',
        'BNM_LIABILITY', 'GUARANTEE_ASSET', 'GUARANTEE_LIABILITY',
        'MERCHANT_DEBT_RECEIVABLE', 'TAKEOVER_PAYABLE',
        'OPERATIONS_ADVANCE_ASSET', 'OPERATIONS_REIMBURSEMENT',
        'SETTLEMENT_CLEARING'
    ));
