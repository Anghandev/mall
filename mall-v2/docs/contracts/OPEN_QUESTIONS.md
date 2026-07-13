# Mall V2 Upstream Open Questions

These decisions change customer copy or transaction steps. The customer app will not infer answers.

| ID | PRD lines | Decision required | Safe customer behavior until resolved |
|---|---:|---|---|
| Q-001 | 4 | Confirm that `用户收款` means customer receipt/pickup completion | Label rewards Locked and hide claim |
| Q-002 | 4,135-144,187-192 | Does the opening rule (all non-prize funds locked until receipt) override referral next-block and operations daily availability copy? | Render only upstream ledger states |
| Q-003 | 4,109,172 | Exact exception between no-reason refunds and seven-day merchant-default refunds | Render only `allowedActions` and upstream disclosure |
| Q-004 | 4,117,172 | Exact per-asset refund deduction after a seckill prize contribution and immediate NPL burn | Display upstream refund preview; never compute locally |
| Q-005 | 17,68-69,152,163 | Per-SKU USDT/NPL price legs and token metadata | Disable checkout without a signed exact quote |
| Q-006 | 22-24,30-31 | Which countdown ends LIVE, and how a boundary transaction is repriced/classified | Display upstream phase/classification only |
| Q-007 | 34,128-130,167-168 | Is BNM minted/locked at payment or only created at receipt? | Use `Locked` wording until upstream says Available |
| Q-008 | 117,173 | When does the USDT prize become claimable relative to the 5-10 minute settling phase? | Keep claim disabled until `allowedActions` enables it |
| Q-009 | 123-144 | The heading says four rewards while the content describes BNM plus four NPL sections | Customer app treats them as five distinct sections |
| Q-010 | 132-133 | Genesis credential standard, identifier, snapshot time, and hidden-vs-disabled behavior | Hide the section unless an entitlement state is supplied |
| Q-011 | 136,139-140 | Referral and four-level region beneficiary snapshot semantics | Display upstream totals without deriving relationships |
| Q-012 | 143-144 | Whether operations rewards are visible to ordinary customers | Hide unless upstream returns an entitled section |
| Q-013 | 4,110,140 | Seven-day clock anchors and evidence for timeout refund/force receipt | Do not derive eligibility from device time |
| Q-014 | 95-100 | Approved address parsing provider and PII retention policy | Support local fixture parsing only in development; production parse disabled until contracted |

