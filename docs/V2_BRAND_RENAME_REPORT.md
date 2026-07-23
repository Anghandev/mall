# 24K商城品牌改名报告

> Historical `.18` branding snapshot only. It does not establish current `.25`
> release readiness, three-buyer mainnet acceptance or production Go.

日期：2026-07-20
品牌提交：`a256082b1c37daebac6236a872f3e3e61c8df342`
生产 release：`a256082b1c37`
Core artifact：`2.0.0-fulfillment-launch.18`

## 结论

对外品牌已统一为 `24K商城`，Mall、Merchant、Admin、Core SIWE 提示和
OpenAPI 展示标题均已发布到生产。品牌改名没有改变合约、ABI、资金公式、
数据库 Schema、PaymentRouter、Policy 或 EOA 钱包角色。

## 已修改展示面

- Mall 页面 title/meta、顶部品牌、首页 aria-label、商城图片 alt 和精选标识。
- Merchant 页面 title/meta、登录页和工作台品牌。
- Admin 页面 title/meta、顶部品牌和 logo alt。
- Core `POST /v2/auth/nonce` 返回的钱包签名提示。
- 当前 README、架构/契约文档标题和验收报告标题。
- OpenAPI 公开标题及其协调 manifest/SHA-256。
- Phase 2 打印文档标题，防止后续启用时重新出现旧品牌。

## 明确保留

以下标识涉及协议兼容、代码引用或历史证据，未作修改：

- Solidity 合约名和已部署合约地址。
- `Abu24KPaymentRouter`、`Abu24KV2Core`、`Abu24KPolicyRegistry`、
  `Abu24KV2Settlement`、`Abu24KCatalog` 和 `Abu24KMerchantPrinter`
  等 EIP-712 domain。
- `@abu24k/*` 内部 workspace 包名和 `x-abu-*` 兼容 header。
- 旧 deployment manifest、主网回执、legacy 原始 PRD 和历史审计证据。

## 验证

| 验证项 | 结果 |
|---|---|
| 可见品牌门禁 | 32 个公开源码/文档/artifact surface 通过 |
| Mall | 106 tests、typecheck、build、bundle guard 通过 |
| Merchant | 93 tests、typecheck、build、bundle guard 通过 |
| Admin | 169 tests、typecheck、build、bundle guard 通过 |
| Core API | 43 tests 通过，包含真实 SIWE 新提示断言 |
| Consumer/artifact | 26 tests；50 个生成文件一致 |
| 合约 | ABI 仍为原三份合约；27 tests 和 128,000 次 invariant 调用通过 |
| 完整门禁 | `pnpm verify` 退出码 0 |
| 生产静态 | 18/18 文件与本地 release 精确一致 |
| 生产浏览器 | 三端 HTTP 200，无旧品牌、JS 异常、请求失败或横向溢出 |
| 生产 Core | readiness 绿色，公网 SIWE 提示包含 `24K商城` |

生成后的 OpenAPI SHA-256 为
`6a1eb5ce664768200a748cc6325e853189a64b6209c91ca64098c160eb471bd1`；
协调 manifest SHA-256 为
`615f8396f14bb6c408674d6da73f2b79c101debe90c585fff5968f2428f760bb`。
ABI bundle 和 contract manifest SHA-256 保持不变。

## 发布边界

首次静态软链切换暴露了 release 静态目录多一层的问题，三端请求返回 500。
系统立即把静态软链切回上一 release，三个页面恢复 200；确认根因后只修正新
release 的目录层级，再次原子切换并完成逐文件校验。Core、数据库和资金状态
未受该静态路径问题影响。

本批次没有部署合约、发布 Policy、创建订单、支付、结算或广播 BSC 交易。
生产业务库仍无订单和支付事件，EOA 执行队列及审计 outbox 均为空。
