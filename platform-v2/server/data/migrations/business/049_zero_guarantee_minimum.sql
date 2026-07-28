DO $$
BEGIN
    IF to_regclass('core.merchant_guarantees') IS NOT NULL THEN
        ALTER TABLE core.merchant_guarantees
            DROP CONSTRAINT IF EXISTS merchant_guarantees_minimum_usdt_check,
            ADD CONSTRAINT merchant_guarantees_minimum_usdt_check CHECK (minimum_usdt >= 0);
    END IF;
END $$;
