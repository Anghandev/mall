CREATE OR REPLACE FUNCTION core.reserve_inventory_with_capacity(
    p_reservation_id text,
    p_reservation_hash text,
    p_policy_version bigint,
    p_sku_id text,
    p_buyer_wallet text,
    p_quantity bigint,
    p_classification text,
    p_expires_at timestamptz,
    p_session_id text,
    p_capacity_reservation_id text
) RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    existing core.inventory_reservations;
    capacity core.inventory_reservations;
    created core.inventory_reservations;
BEGIN
    SELECT * INTO existing
    FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id;

    IF FOUND THEN
        IF existing.reservation_hash = p_reservation_hash
            AND existing.policy_version = p_policy_version
            AND existing.sku_id = p_sku_id
            AND existing.buyer_wallet = p_buyer_wallet
            AND existing.quantity = p_quantity
            AND existing.classification = p_classification
            AND existing.expires_at = p_expires_at
            AND existing.session_id IS NOT DISTINCT FROM p_session_id
            AND existing.capacity_reservation_id = p_capacity_reservation_id
        THEN
            RETURN existing;
        END IF;
        RAISE EXCEPTION 'ReservationConflict' USING ERRCODE = 'P0001';
    END IF;

    IF p_quantity <= 0 OR p_expires_at <= clock_timestamp()
        OR p_capacity_reservation_id IS NULL
        OR (p_classification = 'SECKILL' AND p_session_id IS NULL)
        OR (p_classification = 'ORDINARY' AND p_session_id IS NOT NULL)
    THEN
        RAISE EXCEPTION 'InvalidReservation' USING ERRCODE = 'P0001';
    END IF;

    IF p_reservation_id = p_capacity_reservation_id THEN
        IF p_classification = 'SECKILL' THEN
            -- The displayed LIVE phase is derived from the immutable session timers.
            -- The stored phase can remain PREHEAT until the settlement transition.
            UPDATE core.seckill_sessions
            SET reserved = reserved + p_quantity, updated_at = clock_timestamp()
            WHERE session_id = p_session_id AND sku_id = p_sku_id
              AND policy_version = p_policy_version AND phase IN ('PREHEAT', 'LIVE')
              AND starts_at <= clock_timestamp() AND relay_deadline > clock_timestamp()
              AND main_deadline > clock_timestamp()
              AND inventory - sold - reserved >= p_quantity;
        ELSE
            UPDATE core.skus
            SET stock_available = stock_available - p_quantity,
                stock_reserved = stock_reserved + p_quantity
            WHERE sku_id = p_sku_id
              AND lifecycle_state = 'ACTIVE'
              AND stock_available >= p_quantity;
        END IF;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'InventoryUnavailable' USING ERRCODE = 'P0001';
        END IF;
    ELSE
        IF p_classification <> 'FALLBACK_RETAIL' OR p_session_id IS NULL THEN
            RAISE EXCEPTION 'InvalidReservation' USING ERRCODE = 'P0001';
        END IF;
        SELECT * INTO capacity
        FROM core.inventory_reservations
        WHERE reservation_id = p_capacity_reservation_id
        FOR UPDATE;
        IF NOT FOUND OR capacity.state <> 'ACTIVE'
            OR capacity.classification <> 'SECKILL'
            OR capacity.policy_version <> p_policy_version
            OR capacity.sku_id <> p_sku_id
            OR capacity.buyer_wallet <> p_buyer_wallet
            OR capacity.quantity <> p_quantity
            OR capacity.session_id IS DISTINCT FROM p_session_id
            OR capacity.expires_at <> p_expires_at
        THEN
            RAISE EXCEPTION 'ReservationUnavailable' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    INSERT INTO core.inventory_reservations (
        reservation_id, reservation_hash, policy_version, sku_id, buyer_wallet,
        quantity, classification, session_id, capacity_reservation_id, state, expires_at
    ) VALUES (
        p_reservation_id, p_reservation_hash, p_policy_version, p_sku_id,
        p_buyer_wallet, p_quantity, p_classification, p_session_id,
        p_capacity_reservation_id, 'ACTIVE', p_expires_at
    ) RETURNING * INTO created;

    RETURN created;
END;
$$;
