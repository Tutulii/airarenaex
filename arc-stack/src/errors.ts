export type ErrorDefinition = {
  status: number;
  message: string;
  retryable: boolean;
};

export const ERROR_CATALOG = {
  request_validation_failed: { status: 400, message: "The request payload is invalid.", retryable: false },
  payload_too_large: { status: 413, message: "The request payload exceeds the maximum size.", retryable: false },
  route_not_found: { status: 404, message: "The requested exchange route was not found.", retryable: false },
  rate_limited: { status: 429, message: "The request rate limit was exceeded.", retryable: true },
  origin_not_allowed: { status: 403, message: "The request origin is not allowed.", retryable: false },
  invalid_wallet: { status: 400, message: "The wallet address is invalid.", retryable: false },
  invalid_signature: { status: 401, message: "The wallet signature is invalid.", retryable: false },
  challenge_invalid_or_expired: { status: 401, message: "The authentication challenge is invalid or expired.", retryable: false },
  missing_or_invalid_bearer_token: { status: 401, message: "A valid bearer token is required.", retryable: false },
  invalid_bearer_token: { status: 401, message: "The bearer token is invalid or revoked.", retryable: false },
  insufficient_scope: { status: 403, message: "The token lacks the required scope.", retryable: false },
  operator_unauthorized: { status: 403, message: "Operator authorization failed.", retryable: false },
  order_maker_mismatch: { status: 403, message: "The authenticated wallet does not own this order.", retryable: false },
  valid_idempotency_key_required: { status: 400, message: "A valid Idempotency-Key header is required.", retryable: false },
  idempotency_key_reused: { status: 409, message: "The idempotency key was already used for a different request.", retryable: false },
  idempotency_request_in_progress: { status: 409, message: "The original request is still being processed.", retryable: true },
  idempotency_lease_lost: { status: 409, message: "The request execution lease was lost.", retryable: true },
  exchange_not_configured: { status: 503, message: "The exchange is not configured.", retryable: true },
  auth_unavailable: { status: 503, message: "Authentication is temporarily unavailable.", retryable: true },
  auth_token_issuer_unavailable: { status: 503, message: "The token issuer is temporarily unavailable.", retryable: true },
  receipt_signer_unavailable: { status: 503, message: "The acceptance receipt signer is unavailable.", retryable: true },
  txline_source_unavailable: { status: 503, message: "The fixture source is temporarily unavailable.", retryable: true },
  oracle_witness_not_qualified: { status: 422, message: "A qualifying independent free witness is required.", retryable: false },
  oracle_witness_credential_unavailable: { status: 503, message: "The configured witness credential is unavailable.", retryable: true },
  oracle_witness_fixture_not_found: { status: 422, message: "The witness fixture was not found.", retryable: false },
  oracle_witness_fixture_mismatch: { status: 422, message: "The witness returned a different fixture identity.", retryable: false },
  oracle_witness_paid_subscription_forbidden: { status: 422, message: "Paid witness credentials are disabled for the beta path.", retryable: false },
  oracle_witness_access_tier_mismatch: { status: 422, message: "The witness credential tier does not match the market binding.", retryable: false },
  oracle_witness_source_unavailable: { status: 503, message: "The independent witness source is temporarily unavailable.", retryable: true },
  oracle_primary_fixture_mismatch: { status: 422, message: "The primary oracle fixture binding does not match the market fixture.", retryable: false },
  exchange_halted_oracle_integrity: { status: 503, message: "Order intake is halted because oracle integrity is degraded.", retryable: true },
  exchange_halted_reconciliation: { status: 503, message: "Order intake is halted pending ledger reconciliation.", retryable: true },
  exchange_halted_rpc: { status: 503, message: "Order intake is halted because the Arc RPC is unavailable.", retryable: true },
  exchange_halted_cap: { status: 429, message: "Order intake is halted at a configured risk limit.", retryable: true },
  exchange_halted_custody_safety: { status: 503, message: "Custody safety checks have halted exchange activity.", retryable: false },
  risk_wallet_cap: { status: 422, message: "The wallet reserve cap would be reached.", retryable: false },
  risk_market_cap: { status: 422, message: "The market reserve cap would be reached.", retryable: false },
  risk_batch_cap: { status: 422, message: "The batch notional cap would be reached.", retryable: true },
  risk_treasury_cap: { status: 422, message: "The protocol liquidity treasury cap would be reached.", retryable: false },
  risk_ingress_cap: { status: 429, message: "The order ingress cap would be reached.", retryable: true },
  risk_wallet_rate_cap: { status: 429, message: "The wallet order-rate cap would be reached.", retryable: true },
  risk_active_market_cap: { status: 422, message: "The active-market cap would be reached.", retryable: false },
  risk_global_custody_cap: { status: 503, message: "The global custody cap has been reached.", retryable: false },
  liquidity_market_budget_missing: { status: 403, message: "Protocol liquidity is not enabled for this market.", retryable: false },
  liquidity_budget_overallocated: { status: 503, message: "Protocol liquidity budgets exceed the funded vault.", retryable: false },
  liquidity_oracle_unhealthy: { status: 503, message: "Protocol liquidity is stopped until independent oracle health recovers.", retryable: true },
  liquidity_vault_boundary: { status: 422, message: "The protocol liquidity vault boundary would be exceeded.", retryable: false },
  liquidity_inventory_cap: { status: 422, message: "The protocol liquidity inventory cap would be reached.", retryable: false },
  liquidity_notional_cap: { status: 422, message: "The protocol liquidity notional cap would be reached.", retryable: false },
  liquidity_loss_cap: { status: 422, message: "The protocol liquidity loss cap has been reached.", retryable: false },
  liquidity_drawdown_cap: { status: 422, message: "The protocol liquidity drawdown cap has been reached.", retryable: false },
  liquidity_daily_volume_cap: { status: 422, message: "The protocol liquidity daily-volume cap would be reached.", retryable: true },
  liquidity_funded_budget_exceeded: { status: 422, message: "The quote exceeds the protocol liquidity wallet's funded budget.", retryable: false },
  invalid_close_time: { status: 400, message: "The close time is invalid.", retryable: false },
  invalid_market_id: { status: 400, message: "The market identifier is invalid.", retryable: false },
  invalid_market_category: { status: 400, message: "The market category is invalid.", retryable: false },
  invalid_market_status: { status: 400, message: "The market status is invalid.", retryable: false },
  invalid_market_outcome: { status: 400, message: "The outcome identifier is invalid.", retryable: false },
  market_not_found: { status: 404, message: "The market was not found.", retryable: false },
  market_not_open: { status: 409, message: "The market is not open for orders.", retryable: false },
  market_closed: { status: 409, message: "The market is closed.", retryable: false },
  nonce_digest_conflict: { status: 409, message: "The nonce is already bound to another digest.", retryable: false },
  order_not_found: { status: 404, message: "The order was not found.", retryable: false },
  invalid_order_hash: { status: 400, message: "The order hash is invalid.", retryable: false },
  order_not_cancellable: { status: 409, message: "The order can no longer be cancelled.", retryable: false },
  order_batch_locked: { status: 409, message: "The order is sealed in an executing batch.", retryable: false },
  order_cancellation_cutoff_elapsed: { status: 409, message: "The cancellation cutoff for the assigned batch has elapsed.", retryable: false },
  cancellation_already_pending: { status: 409, message: "A different signed cancellation is already pending.", retryable: false },
  job_not_found: { status: 404, message: "The execution job was not found.", retryable: false },
  invalid_resume_cursor: { status: 400, message: "The resume cursor is invalid.", retryable: false },
  invalid_event_topic: { status: 400, message: "One or more event topics are invalid.", retryable: false },
  batch_not_found: { status: 404, message: "The batch was not found.", retryable: false },
  batch_bundle_not_found: { status: 404, message: "The public batch bundle is not available.", retryable: true },
  internal_error: { status: 500, message: "An internal error occurred.", retryable: true },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export function normalizeError(error: unknown): { code: ErrorCode; definition: ErrorDefinition } {
  if (error instanceof Error && error.name === "ZodError") {
    return { code: "request_validation_failed", definition: ERROR_CATALOG.request_validation_failed };
  }
  const raw = error instanceof Error ? error.message : "internal_error";
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
  const inferred = raw.startsWith("txline_source_http_")
    ? "txline_source_unavailable"
    : raw.startsWith("oracle_witness_http_")
      ? "oracle_witness_source_unavailable"
    : statusCode === 413
      ? "payload_too_large"
      : statusCode === 429
        ? "rate_limited"
        : statusCode === 400
          ? "request_validation_failed"
          : "internal_error";
  const code = (raw in ERROR_CATALOG ? raw : inferred) as ErrorCode;
  return { code, definition: ERROR_CATALOG[code] };
}

export function publicErrorCatalog(): Record<ErrorCode, ErrorDefinition> {
  return ERROR_CATALOG;
}
