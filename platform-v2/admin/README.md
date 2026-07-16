# Abu 24K Platform Admin V2

React + TypeScript operations UI. It owns only `platform-v2/admin/**` and never
implements shared funds, contracts, API, Schema or signer behavior.

## Current Product Boundary

- Production consumes `@abu24k/core-artifacts@2.0.0-settlement-admin.12`.
- SIWE/JWT stays in memory. Every protected read and write is role-bound by
  Core and preserves typed `DecisionBlocked`, `ExternalBlocked`,
  `ConfigurationRequired` and correlation evidence.
- The Admin UI consumes payment/fulfillment, global read-only signed settlement,
  reward subtypes and non-transferable BNM points, merchant guarantee/debt,
  governed takeover funding, policy draft governance, CMS version publication,
  typed system configuration, append-only audit and operations/coverage
  monitoring.
- The clearing workspace reads an order payment independently of the buyer
  wallet, server-side filtered settlement-request and immutable Safe-batch
  lists with stable cursors, and full request/batch detail. It renders Core
  item totals and hashes, Safe nonce and owner approvals, execution replacements,
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
  Yellow queue, exports, printing and arbitrary batch writes remain fail-closed.
- Seckill control consumes current/history session snapshots, numeric-cursor
  HTTP replay, the artifact-bound `/v2/ws` finalized relay stream, action
  list/detail, session inventory locking, force-close, prize injection and
  breaker recovery. Every governed action uses Core-issued EIP-712 typed data,
  an independent secondary wallet and a Safe proposal; `FINAL` is rendered
  only from 15-confirmation Core evidence.
- Policy and takeover funding use Core-issued typed data. The wallet signs the
  exact typed payload; the frontend does not construct calldata, calculate
  funds or set final states.
- The takeover workspace consumes the Core case queue, immutable assignment
  history and eligible replacement-merchant projection. ADMIN/OPERATOR can
  assign or reassign before shipment; AUDITOR remains read-only.
- CMS and configuration editors accept structured JSON objects because their
  coordinated request types are open objects. Core remains the schema,
  sanitization, decision and publication authority.
- The risk workspace consumes Core observations, restrictions, appeals,
  manual restriction, override and appeal-decision contracts. AUDITOR is
  read-only, OPERATOR may only appeal and ADMIN owns the other writes. New UID,
  low-stock thresholds, low-history wallet clustering and frequent
  address/store-change thresholds remain explicit fail-closed capabilities;
  monitoring alerts are never relabeled as transaction-risk events. Global
  batch actions, logistics configuration and production provider accounts
  remain fail-closed as
  recorded in `docs/contracts/UPSTREAM_GAPS.md`. Catalog writes consume `.5`
  runtime RBAC, `allowedActions`, `writeLock` and `blockingResource`; AUDITOR
  is read-only. Existing child categories move to root only through an explicit
  Core `parentCategoryId: null` update.
- Funds, chain, policy, audit and historical evidence surfaces never expose a
  delete control. No production fixture is shipped.
- The logistics checkpoint publishes printer binding, waybill batches and
  durable print jobs under Merchant routes and separate platform logistics
  operations under Admin routes. The merchant-store checkpoint additionally
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
