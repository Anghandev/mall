# Abu 24K V2 Mainnet Micro-Test Report

## Final Conclusion

- Status: `PASS | FAIL | PARTIAL - FIX REQUIRED | NO-GO`
- Can proceed to production deployment: `YES | NO`
- Release artifact/version:
- Git commit:
- Mode-600 packet path:
- Packet SHA-256:

## Commands Executed

```text

```

## Preflight Gate

| Check | Result | Evidence |
|---|---:|---|
| `pnpm micro:preflight` PASS |  |  |
| BSC chainId 56 on both RPCs |  |  |
| Artifact version matches packet |  |  |
| Git commit matches packet |  |  |
| Contract runtime hashes match artifact |  |  |
| Five production role EOAs are distinct |  |  |
| Buyer set is exactly W5 / W1 / W6 |  |  |
| W3 not used as buyer |  |  |
| Buyer wallets do not collide with protocol roles |  |  |
| BNM availability and monotonic evidence configured |  |  |
| Token-value ceiling `<= 3 USDT` |  |  |

## W6 Preparation

| Item | Result | Tx / Evidence |
|---|---:|---|
| W6 wallet created locally, private key not printed |  |  |
| W6 BNM minimum qualification |  |  |
| W6 minimum BNB funding |  |  |
| W6 USDT funding `<= 3 USDT` equivalent action |  |  |
| W6 NPL funding `<= 3 USDT` equivalent action |  |  |
| W6 bounded USDT allowance |  |  |
| W6 bounded NPL allowance |  |  |

## Buyer Payments

| Buyer | Scenario | Payment Tx | Receipt finality | Assertions |
|---|---|---|---|---|
| W5 | ordinary / seckill |  | 15 confirmations |  |
| W1 | ordinary / seckill |  | 15 confirmations |  |
| W6 | ordinary / seckill |  | 15 confirmations |  |

## Wallet Delta Reconciliation

| Asset / Wallet | Expected Delta | Actual Delta | Result |
|---|---:|---:|---:|
| Router USDT residual | 0 |  |  |
| Router NPL residual | 0 |  |  |
| Platform Service Fee USDT |  |  |  |
| USDT Custody/Settlement |  |  |  |
| NPL Burn |  |  |  |
| NPL Reward/Distribution |  |  |  |

## Core / DB / Ledger Evidence

| Area | Result | Evidence |
|---|---:|---|
| PaymentReceiptWorker consumed all tx hashes |  |  |
| Orders projected correctly |  |  |
| Pickup / delivery fulfillment completed |  |  |
| BNM Locked -> Available |  |  |
| Merchant USDT settlement transfer(s) SETTLED |  |  |
| Reward NPL settlement transfer(s) SETTLED |  |  |
| Audit hash chain consistent |  |  |

## Three-End Browser Evidence

| Surface | Result | Evidence |
|---|---:|---|
| Platform Admin |  |  |
| Merchant Workbench |  |  |
| Mall Frontend |  |  |
| Console errors |  |  |
| Failed requests |  |  |
| Responsive / no horizontal overflow |  |  |

## Cleanup Gate And Observation

| Check | Result | Evidence |
|---|---:|---|
| New micro payments paused/blocked |  |  |
| Micro products hidden/delisted |  |  |
| Quotes/reservations expired |  |  |
| Micro entitlement cleared |  |  |
| W6 temporary allowance/qualification cleanup |  |  |
| Core restart clean |  |  |
| Cleanup gate PASS |  |  |
| 600-second observation: 121/121 HTTP 200 |  |  |
| `writesEnabled=true` and `runtimeBlockers=[]` |  |  |

## Transactions

| # | Operation | Function | Value | Gas Used | Cost | Hash | Result |
|---:|---|---|---:|---:|---:|---|---:|

## Failed Items

-

## Risk Points

-

## Next Steps

-
