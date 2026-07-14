import type { SqlExecutor } from './migrations.ts';

export interface InventoryReservationInput {
  reservationId: string;
  reservationHash: string;
  policyVersion: number;
  skuId: string;
  buyerWallet: string;
  quantity: number;
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
  sessionId?: string;
  expiresAt: Date;
}

export interface InventoryReservationRow {
  reservation_id: string;
  state: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'RELEASED';
  quantity: string | number;
  expires_at: Date | string;
}

export async function reserveInventory(executor: SqlExecutor, input: InventoryReservationInput) {
  const result = await executor.query<InventoryReservationRow>(
    `SELECT * FROM core.reserve_inventory($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.reservationId,
      input.reservationHash,
      input.policyVersion,
      input.skuId,
      input.buyerWallet,
      input.quantity,
      input.classification,
      input.expiresAt,
      input.sessionId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('ReservationUnavailable');
  return row;
}

export async function releaseInventory(
  executor: SqlExecutor,
  reservationId: string,
  targetState: 'EXPIRED' | 'RELEASED',
) {
  const result = await executor.query<InventoryReservationRow>(
    'SELECT * FROM core.release_inventory_reservation($1, $2)',
    [reservationId, targetState],
  );
  const row = result.rows[0];
  if (!row) throw new Error('UnknownReservation');
  return row;
}

export async function consumeInventory(executor: SqlExecutor, reservationId: string, orderId: string) {
  const result = await executor.query<InventoryReservationRow>(
    'SELECT * FROM core.consume_inventory_reservation($1, $2)',
    [reservationId, orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('ReservationUnavailable');
  return row;
}
