CREATE FUNCTION core.reserve_inventory(
    p_reservation_id text,
    p_reservation_hash text,
    p_policy_version bigint,
    p_sku_id text,
    p_buyer_wallet text,
    p_quantity bigint,
    p_classification text,
    p_expires_at timestamptz,
    p_session_id text
) RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    existing core.inventory_reservations;
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
        THEN
            RETURN existing;
        END IF;
        RAISE EXCEPTION 'ReservationConflict' USING ERRCODE = 'P0001';
    END IF;

    IF p_quantity <= 0 OR p_expires_at <= clock_timestamp()
        OR ((p_classification = 'SECKILL') <> (p_session_id IS NOT NULL))
    THEN
        RAISE EXCEPTION 'InvalidReservation' USING ERRCODE = 'P0001';
    END IF;

    IF p_classification = 'SECKILL' THEN
        UPDATE core.seckill_sessions
        SET reserved = reserved + p_quantity, updated_at = clock_timestamp()
        WHERE session_id = p_session_id AND sku_id = p_sku_id
          AND policy_version = p_policy_version AND phase = 'LIVE'
          AND starts_at <= clock_timestamp() AND main_deadline > clock_timestamp()
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

    INSERT INTO core.inventory_reservations (
        reservation_id, reservation_hash, policy_version, sku_id, buyer_wallet,
        quantity, classification, session_id, state, expires_at
    ) VALUES (
        p_reservation_id, p_reservation_hash, p_policy_version, p_sku_id,
        p_buyer_wallet, p_quantity, p_classification, p_session_id, 'ACTIVE', p_expires_at
    ) RETURNING * INTO created;

    RETURN created;
END;
$$;

CREATE FUNCTION core.release_inventory_reservation(p_reservation_id text, p_target_state text)
RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    reservation core.inventory_reservations;
BEGIN
    IF p_target_state NOT IN ('EXPIRED', 'RELEASED') THEN
        RAISE EXCEPTION 'InvalidReservationState' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO reservation
    FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'UnknownReservation' USING ERRCODE = 'P0001';
    END IF;
    IF reservation.state <> 'ACTIVE' THEN
        RETURN reservation;
    END IF;

    IF reservation.classification = 'SECKILL' THEN
        UPDATE core.seckill_sessions
        SET reserved = reserved - reservation.quantity, updated_at = clock_timestamp()
        WHERE session_id = reservation.session_id;
    ELSE
        UPDATE core.skus
        SET stock_available = stock_available + reservation.quantity,
            stock_reserved = stock_reserved - reservation.quantity
        WHERE sku_id = reservation.sku_id;
    END IF;

    UPDATE core.inventory_reservations
    SET state = p_target_state, updated_at = clock_timestamp()
    WHERE reservation_id = p_reservation_id
    RETURNING * INTO reservation;
    RETURN reservation;
END;
$$;

CREATE FUNCTION core.consume_inventory_reservation(p_reservation_id text, p_order_id text)
RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    reservation core.inventory_reservations;
BEGIN
    SELECT * INTO reservation
    FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id
    FOR UPDATE;

    IF NOT FOUND OR reservation.state <> 'ACTIVE' OR reservation.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'ReservationUnavailable' USING ERRCODE = 'P0001';
    END IF;

    IF reservation.classification = 'SECKILL' THEN
        UPDATE core.seckill_sessions
        SET reserved = reserved - reservation.quantity,
            sold = sold + reservation.quantity,
            updated_at = clock_timestamp()
        WHERE session_id = reservation.session_id;
    ELSE
        UPDATE core.skus
        SET stock_total = stock_total - reservation.quantity,
            stock_reserved = stock_reserved - reservation.quantity
        WHERE sku_id = reservation.sku_id;
    END IF;

    UPDATE core.inventory_reservations
    SET state = 'CONSUMED', consumed_order_id = p_order_id, updated_at = clock_timestamp()
    WHERE reservation_id = p_reservation_id
    RETURNING * INTO reservation;
    RETURN reservation;
END;
$$;
