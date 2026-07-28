# 24K商城 V2 上线前验收报告

> Historical `.18` acceptance snapshot only. Preserve it for audit, but do not
> use it as current `.30` release or mainnet acceptance evidence.

日期：2026-07-20
生产发布基线：`v2/core@a1c00261dc279af876407bf083e6540312d6da8e`
Core artifact：`2.0.0-fulfillment-launch.18`

## 结论

**历史 `.18` 当时结论为 Go；当前 `.30` artifact 本身不是 Go，必须由外置授权和本 Goal 的证据证明。**

`.18` 的 Go 只保留为历史审计证据，不能替代当前 `.30` release id、
MICROTEST_BUYER_1/2/3 非零奖池主网微测、cleanup gate、外置 release authorization 和 600 秒生产观察。

- `.18` 已闭合单订单手工发货、用户查看/确认收货、平台接管/
  强制确认与仲裁证据保留。
- 快递100、菜鸟、电子面单、打印机、批量发货、自动轨迹、GPS 和地图
  导航均为 Phase 2，未配置不影响下单、支付、手工履约或本地验收。
- 生产 Core、EOA runtime 和三端静态资源已统一发布为 `.18`。
- 生产 migration `038_manual_fulfillment_launch.sql` 已且仅执行一次。
- 公网 readiness 连续 10 分钟、121 个样本全部为
  `writesEnabled=true`、`runtimeBlockers=[]`。

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
| 生产备份恢复 | business/audit 加密备份恢复成功；migration 038 和 audit hash chain 通过 |
| 生产发布 | Core、EOA runtime、Mall、Merchant、Admin 均为 `.18` |
| 生产 readiness | 121/121 样本 HTTP 200、可写且无 runtime blocker |
| 无资金 smoke | 18 个静态文件逐一匹配；公开读取正常；受保护读取无 token 均为 401 |

浏览器证据覆盖启动、可访问性、移动端布局和 fail-closed；Mall 流程使用
mock Core/钱包，Merchant/Admin 没有独立真实 Core 浏览器交易流。手工履约的
真实服务行为由当前 `.18` 的 DB/API 测试证明，不把 mock 当成生产写入证据。

## 链上证据边界

- `bcb999fb03dc` 是当前基线的祖先；之后未改动已部署三份合约、ABI 或
  资金公式，因此不重复扣款或结算。
- 历史收据不证明 `.18` 手工地址、运单明文保护和备注/凭证；这些由
  当前本地服务测试证明。
- 当前启动版本保证金经营要求为 0 USDT；旧 1,000 USDT 保证金动作只作为历史兼容审计，不再作为商家经营门槛。

## 生产发布结果

1. production business/audit 已完成加密备份和隔离恢复验证。
2. Core、EOA runtime 和三端已从 `.17` 切换到同一 `.18` artifact。
3. 正式 Core 的双 RPC、报价源、合约、EOA、Signer 和 Indexer 探针均通过；
   没有放宽或关闭任何资金 readiness 校验。
4. 发布后连续 600 秒、每 5 秒采样一次，共 121 个样本全部通过。
5. 发布过程没有部署合约、发布 Policy、创建订单、签署支付授权或广播链上交易。

物流供应商、打印设备和地图服务不在上述列表中，它们不是本次上线阻塞。

## 旧物清理结果

全量验收通过后，已按引用核对结果清理无引用占位脚本、可重建构建产物、
旧 release 包缓存和失效 worktree 元数据。历史证据、migration、部署 manifest、
V1 归档和独有 WIP 均已保留。清理后第二次完整 `pnpm verify` 退出 0。详见
`docs/V2_LEGACY_ISOLATION_REPORT.md`。
