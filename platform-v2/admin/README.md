# 24K商城 · 平台运营 V2

React + TypeScript operations UI. It owns only `platform-v2/admin/**` and never
implements shared funds, contracts, API, Schema or signer behavior.

## Current Product Boundary

- Production consumes `@abu24k/core-artifacts@2.0.0-fulfillment-launch.23`.
- SIWE/JWT stays in memory. Every protected read and write is role-bound by
  Core and preserves typed `DecisionBlocked`, `ExternalBlocked`,
  `ConfigurationRequired` and correlation evidence.
- The Admin UI consumes payment/fulfillment, global read-only signed settlement,
  reward subtypes and non-transferable BNM points, merchant guarantee/debt,
  governed takeover funding, policy draft governance, CMS version publication,
  typed system configuration, append-only audit and operations/coverage
  monitoring.
- The clearing workspace reads an order payment independently of the buyer
  wallet, server-side filtered settlement-request and immutable EOA-transfer
  lists with stable cursors, and full request/transfer detail. It renders Core
  item totals and hashes, executor nonce and execution evidence, replacements,
  15-confirmation finality, coverage, independent breakers and reconciliation.
  `MINED 14/15`, `FAILED` and `REORGED` never render as final. There is no
  manual transfer, batch construction or browser-side financial calculation.
- The Dashboard consumes the authenticated `GET /v2/admin/dashboard` business
  projection. It renders the Core `Asia/Shanghai` window, immutable order
  amounts, current fulfillment queues, merchant/product/seckill counts,
  signed-settlement totals, failed transactions, coverage and independent
  breakers, plus authoritative abnormal-observation, blacklist-block,
  active-restriction and pending-appeal counts. Nullable ratios and unavailable
  metrics stay visibly fail-closed.
- Admin order operations consume exact Core-side order/product/TxHash/wallet
  search, pending-review and breaker projections, full row `allowedActions`,
  and read-only batch enabled-intersection preview. OR, fuzzy wallet, UID/phone,
  Yellow queue and arbitrary batch writes remain fail-closed. Electronic-waybill
  and printing operations are Phase 2 and absent from the launch UI.
- Seckill control consumes current/history session snapshots, numeric-cursor
  HTTP replay, the artifact-bound `/v2/ws` finalized relay stream, action
  list/detail, session inventory locking, force-close, prize injection and
  breaker recovery. Every governed action uses Core-issued EIP-712 typed data,
  the configured secondary signer and direct Platform Governance EOA execution;
  `FINAL` is rendered only from 15-confirmation Core evidence.
- Policy and takeover funding use Core-issued typed data. The wallet signs the
  exact typed payload; the frontend does not construct calldata, calculate
  funds or set final states.
- Policy drafts no longer accept an Oracle version or TWAP policy fields.
  System configuration consumes the Core `NPL_QUOTE` key for the fixed pair,
  five-minute quote validity and minimum USDT liquidity; Admin never computes
  the signed NPL amount.
- The takeover workspace consumes the Core case queue, immutable assignment
  history and eligible replacement-merchant projection. ADMIN/OPERATOR can
  assign or reassign before shipment; AUDITOR remains read-only.
- The merchant drilldown consumes named sales and fulfillment aggregates, the
  zero-denominator-safe 48-hour ship rate, finalized NPL Burn and Available BNM
  totals. V1-V5 controls are retired. The settlement wallet is permanently
  immutable after approval; neither ordinary profile edits nor Admin governance
  exposes a wallet-change action.
- CMS and configuration editors use structured governed forms. Core remains the
  schema, sanitization, decision and publication authority.
- Notification operations consume the generated campaign projection, including
  delivery-state counts and `allowedActions`. ADMIN/OPERATOR create structured
  ALL/WALLET/MERCHANT/REGION audiences, publish with evidence and retry failed
  deliveries; AUDITOR remains read-only. Missing provider configuration stays
  visibly `ConfigurationRequired` and is never presented as delivery success.
- The risk workspace consumes Core observations, restrictions, appeals,
  manual restriction, override and appeal-decision contracts. AUDITOR is
  read-only, OPERATOR may only appeal and ADMIN owns the other writes. Low-stock
  thresholds, low-history wallet clustering and frequent
  address/store-change thresholds remain explicit fail-closed capabilities;
  monitoring alerts are never relabeled as transaction-risk events. Global
  batch actions remain fail-closed; logistics-provider configuration is Phase 2
  and absent from launch as
  recorded in `docs/contracts/UPSTREAM_GAPS.md`. Catalog writes consume `.5`
  runtime RBAC, `allowedActions`, `writeLock` and `blockingResource`; AUDITOR
  is read-only. Existing child categories move to root only through an explicit
  Core `parentCategoryId: null` update.
- Funds, chain, policy, audit and historical evidence surfaces never expose a
  delete control. No production fixture is shipped.
- The coordinated artifact retains historical Phase 2 printer, waybill and
  logistics-provider APIs for later work, but launch Admin has no logistics
  route, navigation or production call to them. The merchant-store checkpoint
  additionally
  publishes merchant-owned store create, profile update, activate and close
  operations. Admin consumes the coordinated version but exposes no store
  editor and never calls or bundles those Merchant store-management routes.
- The merchant-fulfillment checkpoint publishes the PII-authorized paginated
  order export only at `POST /v2/merchant/orders/exports`. Admin exposes no
  alias for this operation and neither calls nor bundles its route, operation
  ID or generated request/response contracts.
- The order-statement checkpoint publishes Buyer shopping statements and
  Merchant receivable statements. Admin accepts their coordinated capability
  metadata in Core readiness, but exposes no parallel statement UI or API.

## Local Verification

```bash
pnpm --filter @abu24k/platform-admin check
pnpm baseline:check
pnpm requirements:check
pnpm --filter @abu24k/platform-admin dev
```

The development server binds to `http://127.0.0.1:4313`.
