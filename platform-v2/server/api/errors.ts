export const coreErrorCodes = [
  'ArtifactVersionMismatch',
  'BreakerActive',
  'ConfigurationRequired',
  'DecisionBlocked',
  'EmptySessionPrizeDecisionBlocked',
  'ExternalBlocked',
  'FinalityPending',
  'Forbidden',
  'IdempotencyConflict',
  'InvalidFinality',
  'InvalidRequest',
  'InvalidSignature',
  'InventoryUnavailable',
  'NonceExpired',
  'NonceReplay',
  'PickupTakeoverDecisionBlocked',
  'ProviderSignatureInvalid',
  'ProductWriteLocked',
  'QuoteExpired',
  'ReorgPending',
  'ReservationConflict',
  'Unauthorized',
  'UnknownState',
] as const;

export type CoreErrorCode = (typeof coreErrorCodes)[number];

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CoreErrorCode, message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.status = status;
    this.details = Object.freeze({ ...details });
  }
}

export function errorBody(error: unknown, correlationId: string) {
  if (error instanceof CoreError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details, correlationId } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'ExternalBlocked' as const, message: 'Core dependency unavailable', correlationId } },
  };
}
