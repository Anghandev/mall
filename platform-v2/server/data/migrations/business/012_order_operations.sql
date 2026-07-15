CREATE INDEX orders_merchant_cursor_idx
    ON core.orders (merchant_id, created_at DESC, order_id DESC);

CREATE INDEX orders_buyer_cursor_idx
    ON core.orders (buyer_wallet, created_at DESC, order_id DESC);

CREATE INDEX orders_global_cursor_idx
    ON core.orders (created_at DESC, order_id DESC);

CREATE INDEX orders_product_created_idx
    ON core.orders (product_id, created_at DESC, order_id DESC);

CREATE INDEX orders_payment_tx_hash_idx
    ON core.orders (payment_tx_hash)
    WHERE payment_tx_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION core.guard_seckill_session_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.phase IN ('PREHEAT', 'LIVE', 'SETTLING') THEN
        PERFORM sku_id FROM core.skus WHERE sku_id = NEW.sku_id FOR UPDATE;
        IF EXISTS (
            SELECT 1
            FROM core.payment_quotes quote
            WHERE quote.sku_id = NEW.sku_id
              AND quote.quote_kind = 'ORDINARY'
              AND quote.state IN ('QUOTED', 'SUBMITTED', 'REORGED')
              AND quote.deadline > clock_timestamp()
        ) THEN
            RAISE EXCEPTION 'ActiveOrdinaryQuote'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER seckill_session_activation_guard
    BEFORE INSERT OR UPDATE OF phase, starts_at, main_deadline, relay_deadline
    ON core.seckill_sessions
    FOR EACH ROW EXECUTE FUNCTION core.guard_seckill_session_activation();

CREATE TABLE core.fulfillment_shipment_batches (
    batch_id text PRIMARY KEY CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
    request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
    item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (actor_wallet, idempotency_key)
);

CREATE TRIGGER fulfillment_shipment_batches_no_mutation
    BEFORE UPDATE OR DELETE ON core.fulfillment_shipment_batches
    FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
