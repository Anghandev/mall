# Abu 24K Platform Admin V2

React + TypeScript operations UI. It owns only `platform-v2/admin/**` and never
implements shared funds, contracts, API, Schema or signer behavior.

## Current Product Boundary

- Production consumes `@abu24k/core-artifacts@2.0.0-settlement-admin.8`.
- SIWE/JWT stays in memory. Every protected read and write is role-bound by
  Core and preserves typed `DecisionBlocked`, `ExternalBlocked`,
  `ConfigurationRequired` and correlation evidence.
- The Admin UI consumes payment/fulfillment, wallet-scoped signed settlement,
  reward subtypes and non-transferable BNM points, merchant guarantee/debt,
  governed takeover funding, policy draft governance, CMS version publication,
  typed system configuration, append-only audit and operations/coverage
  monitoring.
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
  HTTP replay and the artifact-bound `/v2/ws` finalized relay stream. Scheduling,
  force-close, breaker and prize-injection writes remain fail-closed because no
  coordinated Admin write operation is published.
- Policy and takeover funding use Core-issued typed data. The wallet signs the
  exact typed payload; the frontend does not construct calldata, calculate
  funds or set final states.
- CMS and configuration editors accept structured JSON objects because their
  coordinated request types are open objects. Core remains the schema,
  sanitization, decision and publication authority.
- The risk workspace consumes Core observations, restrictions, appeals,
  manual restriction, override and appeal-decision contracts. AUDITOR is
  read-only, OPERATOR may only appeal and ADMIN owns the other writes. New UID,
  low-stock thresholds, low-history wallet clustering and frequent
  address/store-change thresholds remain explicit fail-closed capabilities;
  monitoring alerts are never relabeled as transaction-risk events. Global
  batch actions, seckill administration, logistics configuration and production
  provider accounts remain fail-closed as
  recorded in `docs/contracts/UPSTREAM_GAPS.md`. Catalog writes consume `.5`
  runtime RBAC, `allowedActions`, `writeLock` and `blockingResource`; AUDITOR
  is read-only. Existing child categories move to root only through an explicit
  Core `parentCategoryId: null` update.
- Funds, chain, policy, audit and historical evidence surfaces never expose a
  delete control. No production fixture is shipped.

## Local Verification

```bash
pnpm --filter @abu24k/platform-admin check
pnpm baseline:check
pnpm requirements:check
pnpm --filter @abu24k/platform-admin dev
```

The development server binds to `http://127.0.0.1:4313`.
