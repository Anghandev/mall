# 24K Web3 商城

24K 是运行在 BNB Smart Chain 的三端 Web3 商城：C 端 App、商家独立后台和平台运营后台。商城仅使用 NPL 支付，NPL 合约固定为：

```text
0x4e8277ab31e4956b2cd48449793a57656dfc03d2
```

最新青雀需求覆盖旧实现：

- 24K 商城需求文档 (private source omitted)
- 24K 商家独立后台需求文档 (private source omitted)
- 24K 平台运营后台 (private source omitted)

## 产品范围

### C 端 App

- 秒杀大厅：链上场次、主倒计时、接力倒计时、NPL 奖池、滚动墙、规则、战报和中奖 Claim。
- 常规商城：商品、SKU、数量、快递/自提、地址/门店、库存复核和付前五要素终核。
- 线下门店：地区筛选、GPS 距离、拨号、导航、自提和行政区编码绑定。
- 我的资产：地址仓、订单、BNM 账本、节点/直推/区域/运维收益和 Claim 状态。

### 商家后台

入口：`/merchant`

- SIWE 登录和白名单校验。
- 商家资料维护；钱包和审核状态不可由商家修改。
- 一店一单品、草稿、提交审核、上架死锁和下架审核。
- 订单发货、电子面单、自提核销、物流状态和打印任务。
- 二次签名订单导出。
- NPL/BNM 资产、Pending Claim 恢复、重试、取消和链上状态轮询。
- 帮助中心与商家审计日志。

### 平台运营后台

入口：`/admin`

- Dashboard、全局检索、批量审核/导出/打印。
- 商家链上白名单审核和商品主数据审核。
- 版本化 NPL 分账比例，链上事件确认后才激活。
- 秒杀排期、到点钱包签名发布、NPL 奖池和强截止。
- 风控、黑名单、物流、强制退款、CMS、通知和系统配置。
- 所有写操作使用 Admin SIWE JWT + 钱包二次签名并写审计日志。

## 链上系统

- `Abu24KPaymentEscrow`：NPL 托管、版本化分账、商家白名单、完成结算、仲裁退款和应急退款。
- `BNMToken`：消费返还凭证。
- `Abu24KRewardLedger`：BNM/NPL 奖励锁定、释放、Claim 和原子销毁。
- `Abu24KSeckill`：仅接受匹配商品、达到最低 NPL 金额且已进入 Escrow `PaidLocked` 的订单。

透明熔断能力：

- Escrow `pause/unpause/emergencyRefund`。
- RewardLedger `pause/unpause/emergencyBurnUnclaimed`。
- Seckill `pause/unpause/forceClose`。

合约 owner 应转交多签。生产 API 不保存或读取部署私钥。

## 支付流程

1. DApp 调用 `POST /api/dapp/final-check` 完成五要素终核。
2. DApp 调用 `POST /api/dapp/checkout-intent`。
3. allowance 不足时，只发送一笔 NPL `approve(MaxUint256)`。
4. 发送后端返回的九参数 `payOrder(...)` 交易，不允许前端自行构造 calldata。
5. 索引器验证并写入 `OrderPaid` 后，订单才进入 `PaidLocked`。
6. 签收/核销后发送 `completeOrder`；`OrderCompleted` 才释放货款和 BNM。

秒杀必须通过 `POST /api/dapp/seckill-intent`。进行中的秒杀商品会在服务端拒绝普通 checkout；付款确认后再发送后端返回的 `recordPurchase(sessionId, orderId)`。

非 `Active` 商品不会出现在公开列表，也不能终核、建单或付款。

## 核心接口

- DApp 聚合：`/api/dapp/home`、`/api/dapp/seckill-state`、`/api/dapp/mall-state`、`/api/dapp/stores-state`、`/api/dapp/assets-state`。
- 交接契约：`/.well-known/24k-dapp.json`、`/api/dapp/contracts.json`、`/api/dapp/openapi.json`、`/api/dapp/types.d.ts`、`/api/dapp/sdk.ts`。
- 购买：`/api/dapp/final-check`、`/api/dapp/checkout-intent`、`/api/dapp/seckill-intent`。
- 订单：`/api/dapp/order-state`、`/api/orders/:id/fund-tx-status`、`/api/dapp/complete-order-intent`。
- 退款：`/api/orders/:id/timeout-actions`、`/api/dapp/timeout-refund-request`。
- Claim：`/api/dapp/claim-intent`、`/api/dapp/claim-tx-status`。
- 商家：`/api/merchant/*`。
- 平台：`/api/admin/*`。

完整前端接入说明见 `DAPP_FRONTEND_HANDOFF.md`。

交接与发布检查产物：

- `pnpm dapp:frontend-pack`：重新生成公开 SDK/types/OpenAPI/ABI 并打包前端交接资料，包内禁止服务端密钥。
- `pnpm dapp:wallet-launch`：生成手机钱包/DEX 浏览器 HTTPS 启动清单与二维码目标。
- `pnpm dapp:deploy-readiness`：生成无私钥、无交易的部署准备报告。
- `pnpm dapp:strict-gate`：默认 fail-closed，聚合合约、生产环境、入口和前端交接门禁。
- `pnpm dapp:strict-gate -- --report-only`：只生成失败报告，供未完成配置时打包诊断产物。
- `DAPP_BASE_URL=https://api.example.com pnpm dapp:handoff` / `dapp:contracts`：只从真实部署 API 生成正式交接物；本地验证必须显式使用对应的 `:fixtures` 命令。

## 本地验证

```bash
pnpm typecheck
pnpm contracts:test
pnpm backend:check
pnpm server:ops-check
pnpm dapp:check
pnpm dapp:frontend-check
pnpm app:check
pnpm e2e:full
pnpm audit:mvp
```

本地预览：

- C 端：`http://localhost:8787/preview`
- 商家后台：`http://localhost:8787/merchant`
- 平台后台：`http://localhost:8787/admin`

## 生产配置

生产服务使用 `NODE_ENV=production`，并且会 fail-closed。至少需要：

- HTTPS API/前端入口、`CORS_ORIGINS`、Reown project id。
- Escrow、BNM、RewardLedger、Seckill 地址和各自 from-block。
- `ADMIN_WALLET_ADDRESS`、`ORDER_SIGNER_ADDRESS`、`ESCROW_SPLIT_VERSION`。
- 相互不同且至少 32 字符的 `JWT_SECRET`、`ADMIN_SECRET`、`INDEXER_SECRET`。
- 绝对路径持久化 `DB_PATH`、HTTPS `CHAIN_EVENT_RPC_URL`。
- 外部订单签名、地图、电子面单、物流查询、打印和通知 provider。
- `ALLOW_UNVERIFIED_CHAIN_EVENTS=false`。
- 生产服务环境中不得出现 `PRIVATE_KEY`。

初始化真实生产 API 环境并严格检查：

```bash
pnpm prod:env:init
# 本机填写 .env.production 中仍为空的域名、合约、多签和 provider 配置
pnpm dapp:prod-check
pnpm dapp:strict-gate -- --strict
```

`server:prod` 只读取 `.env.production`；部署私钥仍留在本机部署环境，生产 API 不会加载它。`.env.production.example` 是 API 模板，`.env.deploy.example` 是离线部署和主网微测模板。`dapp:prod-env` 只用于导出可审阅模板，不能代替对真实 `.env.production` 的检查。

`dapp:prod-check` 默认就是 strict；缺少任一生产条件会以非零状态退出。生产启动命令：

```bash
pnpm server:prod
```

SQLite 上线前必须完成备份与恢复演练：

```bash
pnpm db:backup -- --db /absolute/path/24k.db --out /absolute/path/backups/24k-$(date +%Y%m%d%H%M%S).db
# 恢复前停止 API 和索引器，确认数据库没有 -wal/-shm sidecar
pnpm db:restore -- --backup /absolute/path/backups/24k-backup.db --db /absolute/path/24k.db --rollback /absolute/path/backups/24k-before-restore.db
curl -fsS https://api.example.com/health
```

恢复脚本会做完整性检查、保留 rollback 副本并使用恢复锁；API 检测到恢复锁时拒绝启动。

## 部署顺序

1. `pnpm deploy:rewards -- --write-env`
2. `pnpm deploy:escrow -- --write-env`
3. `pnpm deploy:seckill -- --write-env`
4. 分别运行 `deploy:check-rewards`、`deploy:check-escrow`、`deploy:check-seckill`。
5. 启动 API 和索引器，确认 Seller/Split/Order/Reward/Seckill 事件同步。
6. 运行 strict gate。
7. 只用超小金额执行 BSC approve/pay/refund、Claim 和秒杀链测；任一断言失败或 Gas 超预算立即停止。

部署和主网微测脚本会读取本机部署 `.env`，不会打印 `PRIVATE_KEY`。生产 API 只读取 `.env.production`。不要在聊天、日志、报告或生产服务器中传递私钥。
