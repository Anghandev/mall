ALTER TABLE core.inventory_reservations
    ADD COLUMN capacity_reservation_id text;

UPDATE core.inventory_reservations
SET capacity_reservation_id = reservation_id
WHERE capacity_reservation_id IS NULL;

ALTER TABLE core.inventory_reservations
    ALTER COLUMN capacity_reservation_id SET NOT NULL,
    ADD CONSTRAINT inventory_reservations_capacity_reservation_fk
        FOREIGN KEY (capacity_reservation_id)
        REFERENCES core.inventory_reservations(reservation_id),
    DROP CONSTRAINT inventory_reservations_check,
    ADD CONSTRAINT inventory_reservations_session_check CHECK (
        classification <> 'SECKILL' OR session_id IS NOT NULL
    ),
    ADD CONSTRAINT inventory_reservations_capacity_check CHECK (
        capacity_reservation_id = reservation_id
        OR (classification = 'FALLBACK_RETAIL' AND session_id IS NOT NULL)
    );

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

CREATE OR REPLACE FUNCTION core.reserve_inventory(
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
BEGIN
    RETURN core.reserve_inventory_with_capacity(
        p_reservation_id,
        p_reservation_hash,
        p_policy_version,
        p_sku_id,
        p_buyer_wallet,
        p_quantity,
        p_classification,
        p_expires_at,
        p_session_id,
        p_reservation_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION core.release_inventory_reservation(p_reservation_id text, p_target_state text)
RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    reservation core.inventory_reservations;
    capacity core.inventory_reservations;
    capacity_consumed boolean;
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

    SELECT * INTO capacity
    FROM core.inventory_reservations
    WHERE reservation_id = reservation.capacity_reservation_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'UnknownReservation' USING ERRCODE = 'P0001';
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM core.inventory_reservations
        WHERE capacity_reservation_id = capacity.reservation_id AND state = 'CONSUMED'
    ) INTO capacity_consumed;

    IF NOT capacity_consumed THEN
        IF capacity.session_id IS NOT NULL THEN
            UPDATE core.seckill_sessions
            SET reserved = reserved - capacity.quantity, updated_at = clock_timestamp()
            WHERE session_id = capacity.session_id AND reserved >= capacity.quantity;
        ELSE
            UPDATE core.skus
            SET stock_available = stock_available + capacity.quantity,
                stock_reserved = stock_reserved - capacity.quantity
            WHERE sku_id = capacity.sku_id AND stock_reserved >= capacity.quantity;
        END IF;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'InventoryUnavailable' USING ERRCODE = 'P0001';
        END IF;
        UPDATE core.inventory_reservations
        SET state = p_target_state, updated_at = clock_timestamp()
        WHERE capacity_reservation_id = capacity.reservation_id AND state = 'ACTIVE';
    ELSE
        UPDATE core.inventory_reservations
        SET state = p_target_state, updated_at = clock_timestamp()
        WHERE reservation_id = reservation.reservation_id;
    END IF;

    SELECT * INTO reservation
    FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id;
    RETURN reservation;
END;
$$;

CREATE OR REPLACE FUNCTION core.consume_inventory_reservation_with_capacity(
    p_reservation_id text,
    p_order_id text,
    p_consumed_at timestamptz,
    p_require_unexpired boolean
) RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    reservation core.inventory_reservations;
    capacity core.inventory_reservations;
    governed boolean;
BEGIN
    SELECT * INTO reservation
    FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id
    FOR UPDATE;
    IF NOT FOUND OR reservation.state <> 'ACTIVE'
        OR (p_require_unexpired AND reservation.expires_at <= p_consumed_at)
    THEN
        RAISE EXCEPTION 'ReservationUnavailable' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO capacity
    FROM core.inventory_reservations
    WHERE reservation_id = reservation.capacity_reservation_id
    FOR UPDATE;
    IF NOT FOUND OR (capacity.state <> 'ACTIVE' AND capacity.reservation_id <> reservation.reservation_id) THEN
        RAISE EXCEPTION 'ReservationUnavailable' USING ERRCODE = 'P0001';
    END IF;

    IF capacity.session_id IS NOT NULL THEN
        UPDATE core.seckill_sessions
        SET reserved = reserved - capacity.quantity,
            sold = sold + capacity.quantity,
            updated_at = clock_timestamp()
        WHERE session_id = capacity.session_id AND reserved >= capacity.quantity
        RETURNING governance_action_id IS NOT NULL INTO governed;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'InventoryUnavailable' USING ERRCODE = 'P0001';
        END IF;
        IF governed THEN
            UPDATE core.skus sku
            SET stock_total = stock_total - capacity.quantity,
                stock_seckill_locked = stock_seckill_locked - capacity.quantity
            FROM core.seckill_sessions session
            WHERE session.session_id = capacity.session_id
              AND session.sku_id = sku.sku_id
              AND sku.stock_seckill_locked >= capacity.quantity;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'InventoryUnavailable' USING ERRCODE = 'P0001';
            END IF;
        END IF;
    ELSE
        UPDATE core.skus
        SET stock_total = stock_total - capacity.quantity,
            stock_reserved = stock_reserved - capacity.quantity
        WHERE sku_id = capacity.sku_id AND stock_reserved >= capacity.quantity;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'InventoryUnavailable' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    UPDATE core.inventory_reservations
    SET state = 'CONSUMED', consumed_order_id = p_order_id, updated_at = clock_timestamp()
    WHERE reservation_id = reservation.reservation_id
    RETURNING * INTO reservation;
    RETURN reservation;
END;
$$;

CREATE OR REPLACE FUNCTION core.consume_inventory_reservation_at(
    p_reservation_id text,
    p_order_id text,
    p_consumed_at timestamptz
) RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
BEGIN
    RETURN core.consume_inventory_reservation_with_capacity(
        p_reservation_id, p_order_id, p_consumed_at, true
    );
END;
$$;

CREATE OR REPLACE FUNCTION core.consume_inventory_reservation(p_reservation_id text, p_order_id text)
RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
BEGIN
    RETURN core.consume_inventory_reservation_with_capacity(
        p_reservation_id, p_order_id, clock_timestamp(), true
    );
END;
$$;

CREATE OR REPLACE FUNCTION core.consume_reorged_inventory_reservation(
    p_reservation_id text,
    p_order_id text
) RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
BEGIN
    RETURN core.consume_inventory_reservation_with_capacity(
        p_reservation_id, p_order_id, clock_timestamp(), false
    );
END;
$$;

CREATE OR REPLACE FUNCTION core.restore_reorged_inventory_reservation(p_reservation_id text)
RETURNS core.inventory_reservations
LANGUAGE plpgsql AS $$
DECLARE
    reservation core.inventory_reservations;
    capacity core.inventory_reservations;
    governed boolean;
BEGIN
    SELECT * INTO reservation
    FROM core.inventory_reservations
    WHERE reservation_id = p_reservation_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'UnknownReservation' USING ERRCODE = 'P0001';
    END IF;
    IF reservation.state = 'ACTIVE' THEN
        RETURN reservation;
    END IF;
    IF reservation.state <> 'CONSUMED' THEN
        RAISE EXCEPTION 'InvalidReservationState' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO capacity
    FROM core.inventory_reservations
    WHERE reservation_id = reservation.capacity_reservation_id
    FOR UPDATE;
    IF NOT FOUND OR capacity.state NOT IN ('ACTIVE', 'CONSUMED') THEN
        RAISE EXCEPTION 'InvalidReservationState' USING ERRCODE = 'P0001';
    END IF;

    IF capacity.session_id IS NOT NULL THEN
        UPDATE core.seckill_sessions
        SET sold = sold - capacity.quantity,
            reserved = reserved + capacity.quantity,
            updated_at = clock_timestamp()
        WHERE session_id = capacity.session_id AND sold >= capacity.quantity
        RETURNING governance_action_id IS NOT NULL INTO governed;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'InventoryUnavailable' USING ERRCODE = 'P0001';
        END IF;
        IF governed THEN
            UPDATE core.skus sku
            SET stock_total = stock_total + capacity.quantity,
                stock_seckill_locked = stock_seckill_locked + capacity.quantity
            FROM core.seckill_sessions session
            WHERE session.session_id = capacity.session_id
              AND session.sku_id = sku.sku_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'InventoryUnavailable' USING ERRCODE = 'P0001';
            END IF;
        END IF;
    ELSE
        UPDATE core.skus
        SET stock_total = stock_total + capacity.quantity,
            stock_reserved = stock_reserved + capacity.quantity
        WHERE sku_id = capacity.sku_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'InventoryUnavailable' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    UPDATE core.inventory_reservations
    SET state = 'ACTIVE', consumed_order_id = NULL, updated_at = clock_timestamp()
    WHERE reservation_id = reservation.reservation_id
    RETURNING * INTO reservation;
    RETURN reservation;
END;
$$;
