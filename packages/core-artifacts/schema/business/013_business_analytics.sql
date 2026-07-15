CREATE INDEX transaction_finality_business_day_idx
    ON core.transaction_finality (resource_type, state, finalized_at, resource_id)
    WHERE state = 'FINAL';

CREATE INDEX fulfillment_evidence_type_recorded_idx
    ON core.fulfillment_evidence (evidence_type, recorded_at, order_id);

CREATE INDEX fulfillment_requests_state_requested_idx
    ON core.fulfillment_requests (state, requested_at, order_id, request_type);

CREATE INDEX settlement_requests_requested_cursor_idx
    ON core.settlement_requests (requested_at DESC, request_id DESC);

CREATE INDEX settlement_requests_settled_cursor_idx
    ON core.settlement_requests (settled_at DESC, request_id DESC)
    WHERE settled_at IS NOT NULL;

CREATE INDEX merchants_created_cursor_idx
    ON core.merchants (created_at DESC, merchant_id DESC);

CREATE INDEX seckill_sessions_created_cursor_idx
    ON core.seckill_sessions (created_at DESC, session_id DESC);
