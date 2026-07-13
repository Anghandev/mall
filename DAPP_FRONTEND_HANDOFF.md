# 24K DApp 前端交接

## 固定口径

- Chain：BNB Smart Chain，`chainId=56` / `0x38`。
- NPL：`0x4e8277ab31e4956b2cd48449793a57656dfc03d2`。
- 支付资产：仅 NPL。
- 首次支付：allowance 不足时发送一笔 NPL `approve(MaxUint256)`；额度足够则跳过。
- BNM：RewardLedger 中锁定、释放、Claim 或销毁，不是支付资产。
- 生产前端和 API 必须使用 HTTPS。
- 前端不得持有 `PRIVATE_KEY`，不得自行构造支付或管理合约 calldata。

## 启动

1. 连接 Reown 钱包并完成 SIWE buyer 登录。
2. 调用 `/api/dapp/launch-status`；存在 blocker 时禁止付款。
3. 调用 `/api/dapp/home?address=<wallet>` 渲染四个 Tab。
4. 使用 bootstrap/integration 返回的参数切换到 BSC。

四个 Tab：

- `/api/dapp/seckill-state?address=<wallet>`
- `/api/dapp/mall-state?address=<wallet>`
- `/api/dapp/stores-state?address=<wallet>&lat=<lat>&lng=<lng>`
- `/api/dapp/assets-state?address=<wallet>`

## 普通购买

1. `GET /api/products/:id` 获取 SKU、履约模式和秒杀锁定状态。
2. `GET /api/dapp/fulfillment-options` 获取买家地址与附近自提门店。
3. `POST /api/dapp/final-check` 展示商品、SKU/数量、地址或门店/行政区、NPL 和 BNM Locked 五要素。
4. `POST /api/dapp/checkout-intent` 获取订单和 `paymentIntent`。
5. 根据 `allowanceChecks` 判断是否发送 `approvalTransactions[0]`。
6. 直接发送 `payOrderTransaction`。
7. 广播 txHash 后轮询 `/api/dapp/order-state` 或订单 funding status。

只有索引器确认 `OrderPaid` 后才显示 `PaidLocked`。`pending` 可继续轮询；`failed`、`mismatch`、`rpc_unavailable` 必须显示明确错误。

公开商品只包含 `Active`。进行中的秒杀商品会被服务端拒绝普通 checkout，不能通过直接调 API 绕过。

## 秒杀购买

1. 读取 `/api/dapp/seckill-state`，只有 `phase.key=live` 且 `cta.enabled=true` 才允许购买。
2. 调用 `POST /api/dapp/seckill-intent`，不要调用普通 checkout。
3. 完成返回的 NPL allowance/approve/payOrder 流程。
4. 等待订单 `PaidLocked`。
5. 发送 `seckill.recordPurchaseTransaction`。
6. 通过 `/api/seckill/feed/stream?sessionId=<id>` 和状态接口刷新接力时间与战报。

秒杀场次由平台先链下排期，到点后管理员钱包签名发送 `startSession`；只有索引到 `SessionStarted` 才会成为 live。

## 履约与退款

- 快递：商家发货后订单进入 `Shipped`。
- 自提：门店核销后进入 `PickupReady`。
- 买家确认：`POST /api/dapp/complete-order-intent`，发送返回的 `completeOrderTransaction`。
- 商家 7 天未发货：读取 timeout actions，调用 `/api/dapp/timeout-refund-request`，等待平台链上 `forceRefund`。
- 不开放用户无理由退款。
- pause 场景下平台仍可使用透明 emergency refund 完成恢复。

## Claim

1. `POST /api/dapp/claim-intent`。
2. 对返回的 `secondaryMessage` 执行 `personal_sign`。
3. 把签名提交到返回的 submit endpoint。
4. 若返回 `claimTransaction`，发送 `RewardLedger.claim(entryId)`。
5. 轮询 `/api/dapp/claim-tx-status`；只有 `RewardClaimed` 才显示 Claimed。

Pending Claim 支持刷新恢复、重试和取消。交易 txHash 已广播后不允许取消。

## 机器可读契约

- Discovery：`/.well-known/24k-dapp.json`
- Integration：`/api/dapp/integration`
- Bootstrap：`/api/dapp/bootstrap?address=<wallet>`
- Contracts/ABI：`/api/dapp/contracts.json`
- OpenAPI：`/api/dapp/openapi.json`
- Types：`/api/dapp/types.d.ts`
- SDK：`/api/dapp/sdk.ts`
- Handoff bundle：`/api/dapp/handoff?address=<wallet>`

前端优先消费 API 返回的 endpoint、transaction intent 和状态，不复制服务端常量。

## 验收

```bash
pnpm typecheck
pnpm dapp:frontend-check
pnpm dapp:check
pnpm app:check
```

上线前还必须由主项目运行：

```bash
pnpm dapp:prod-check
pnpm dapp:strict-gate -- --strict
```

主网链测只使用超小 NPL 金额，并受单笔、总预算和 Gas 上限保护。
