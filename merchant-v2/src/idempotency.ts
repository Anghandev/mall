const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const IDEMPOTENCY_SAFE_CHARS = /[^A-Za-z0-9:_-]/g;

export function safeIdempotencyKey(scope: string, options: { prefix?: string } = {}) {
  const random = commandNonce();
  const prefix = options.prefix ? sanitize(options.prefix) : '';
  const separator = prefix ? '-' : '';
  const maxScopeLength = IDEMPOTENCY_KEY_MAX_LENGTH - prefix.length - separator.length - 1 - random.length;
  const safeScope = sanitize(scope).slice(0, Math.max(1, maxScopeLength)) || 'command';
  return `${prefix}${separator}${safeScope}-${random}`;
}

function sanitize(value: string) {
  return value.replace(IDEMPOTENCY_SAFE_CHARS, '_').replace(/_+/g, '_').replace(/^[-_:]+|[-_:]+$/g, '');
}

function commandNonce() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
