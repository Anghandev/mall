# 24K 商城 V2 上线前验收报告

日期：2026-07-20
本地基线：`v2/core@79f93885d70f74fd21ef40d8d9e611263d6c23f2`
Core artifact：`2.0.0-fulfillment-launch.18`

## 结论

**本地首发功能验收 Go；当前生产发布 No-Go。**

- `.18` 已闭合单订单手工发货、用户查看/确认收货、平台接管/
  强制确认与仲裁证据保留。
- 快递100、菜鸟、电子面单、打印机、批量发货、自动轨迹、GPS 和地图
  导航均为 Phase 2，未配置不影响下单、支付、手工履约或本地验收。
- 生产仍运行 `.17`，且当前购买 readiness 为关闭状态，所以不能宣布
  已上线或已可购买。

## 可用业务链

1. 商家从订单输入支持的快递公司、原始运单号和可选备注/凭证。
2. Core 先创建加密、订单绑定的 tracking evidence，再记录 shipment。
3. 用户订单投影显示真实发货信息，确认收货只经 Core `allowedActions`。
4. 商家只能申请强制签收；平台审核后才能完成最终状态。
5. 逾期可进入平台接管和替代商家履约；仲裁期间发货证据不可变，资金保持
   Locked/Disputed，不跳过最终性。

## 验证证据

| 门禁 | 结果 |
|---|---|
| Mall | 106 tests，typecheck/build/bundle guard 通过 |
| Merchant | 93 tests，typecheck/build/bundle guard 通过 |
| Admin | 169 tests，typecheck/build/bundle guard 通过 |
| Database | 77/77，包含手工发货、撤权、仲裁、强制签收、接管和备份恢复 |
| API / workers | 43/43 |
| Micro guard | 3/3 |
| Consumer / artifacts | 26/26，`.18` 50 个生成文件一致 |
| Combined E2E | 接管 1/1，跨端契约 14/14，三端浏览器启动 6/6 |
| Mall Playwright | 15 passed，9 个按项目配置 skipped |
| BSC 历史证据 | 已证明普通/秒杀支付、Router 零留存、Breaker 和双资产 EOA 15 确认结算 |
| 最终 `pnpm verify` | 退出码 0；27 个合约测试，含 128,000 次 invariant 调用 |

浏览器证据覆盖启动、可访问性、移动端布局和 fail-closed；Mall 流程使用
mock Core/钱包，Merchant/Admin 没有独立真实 Core 浏览器交易流。手工履约的
真实服务行为由当前 `.18` 的 DB/API 测试证明，不把 mock 当成生产写入证据。

## 链上证据边界

- `bcb999fb03dc` 是当前基线的祖先；之后未改动已部署三份合约、ABI 或
  资金公式，因此不重复扣款或结算。
- 历史收据不证明 `.18` 手工地址、运单明文保护和备注/凭证；这些由
  当前本地服务测试证明。
- 1,000 USDT 保证金主网动作超出微额测试上限，不使用小金额伪装该门槛。

## 上线前仍需完成

1. 对生产 business/audit 执行真实备份并验证恢复。
2. 将 Core 和三端从 `.17` 发布为同一 `.18` artifact。
3. 修复并验证非敏感 readiness 原因：`RPC_DIVERGENCE`、
   `QUOTE_SOURCE_UNHEALTHY`、`CONTRACT_EVIDENCE_UNVERIFIED`。
4. 发布后连续观察，只有 `writesEnabled=true` 且 `runtimeBlockers=[]`
   才能开放购买。不得用关闭校验的方式变绿。

物流供应商、打印设备和地图服务不在上述列表中，它们不是本次上线阻塞。

## 旧物清理结果

全量验收通过后，已按引用核对结果清理无引用占位脚本、可重建构建产物、
旧 release 包缓存和失效 worktree 元数据。历史证据、migration、部署 manifest、
V1 归档和独有 WIP 均已保留。清理后第二次完整 `pnpm verify` 退出 0。详见
`docs/V2_LEGACY_ISOLATION_REPORT.md`。
