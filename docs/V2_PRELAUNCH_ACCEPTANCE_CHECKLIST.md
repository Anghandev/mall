# 24K 商城 V2 上线前全量验收清单

验收日期：2026-07-20
生产发布基线：`v2/core@a1c00261dc279af876407bf083e6540312d6da8e`
Core artifact：`2.0.0-fulfillment-launch.18`

状态只使用 `Pass` / `Fail` / `Pending` / `Phase2` / `External`。`Pass`
必须有本清单中列出的命令、测试、运行或不可变历史证据；空页、
禁用按钮、mock 成功或单纯“没发现问题”不算通过。

## 1. 基线和产物

| 验收项 | 状态 | 证据 |
|---|---|---|
| 发布 HEAD 精确为 `a1c00261...` | Pass | `git rev-parse HEAD` |
| 验收开始时工作区干净 | Pass | `git status --short` 无输出 |
| Mall / Merchant / Admin 消费同一 artifact | Pass | 三份 `package.json` 均为 `workspace:2.0.0-fulfillment-launch.18` |
| OpenAPI SHA-256 | Pass | `8d1595cc3060e0c41c9d561f1ac9448b379f48028db93fc00201893a85bd1efb` |
| ABI bundle SHA-256 | Pass | `5d67dc25e3e9b2b65937d0ae3ec76f7eeddd2d8b6d02dad99a7cef6012441bb3` |
| Contract manifest SHA-256 | Pass | `75b60e14831e82acb483de0dfa7ba8704eb5b1eb3c32babe9cbdf1efd3fa580e` |
| Coordinated manifest SHA-256 | Pass | `13a6866b60cab0a1b46813608f7b2675f1aad36577c965c845c203968e8d3852` |
| 最终完整 `pnpm verify` | Pass | 2026-07-20 完整门禁退出码 0 |

## 2. Mall 商城端

| 真实操作 | 状态 | 必要证据 |
|---|---|---|
| EOA 钱包 SIWE 登录、错链/拒签失败 | Pass | `api:check` SIWE/RBAC + Mall 106 tests |
| BNM 已注册可购买，未注册在预留/签名前拒绝 | Pass | `api:check` role resolution + `database:check` BNM lifecycle |
| 商品列表、详情、SKU、库存及上下架状态 | Pass | Mall 106 tests/build + Catalog DB tests |
| 手工地址：省/市/区/六位码/详细地址 | Pass | Mall mobile E2E + encrypted target DB tests |
| 自提门店、自提目标与 0 运费 | Pass | Quote/target DB tests + Mall UI tests |
| Core 精确报价、授权、下单及重放保护 | Pass | Contract/Core/consumer tests + 历史 BSC 收据 |
| 订单状态、真实发货信息、确认收货 | Pass | `.18` DB/API/UI tests; 浏览器是 mock Core，未冒充真实写入 |
| 资产页的 USDT/NPL 五状态、BNM Locked/Available | Pass | Settlement projection + Mall UI tests |

## 3. Merchant 商家端

| 真实操作 | 状态 | 必要证据 |
|---|---|---|
| 商家资料、审核状态、脱敏与授权读取 | Pass | Merchant lifecycle DB/API + Merchant 93 tests |
| 审核通过后结算钱包无条件不可更换 | Pass | DB/API/consumer 负向测试 |
| 商品创建、SKU、库存、提交审核、上下架 | Pass | Catalog DB/API + Merchant UI tests |
| 固定运费 USDT，自提运费为 0 | Pass | Quote/payment conservation tests |
| 单订单手工发货：快递公司、运单号、备注/凭证 | Pass | tracking evidence -> shipment -> projection DB/API/UI tests |
| 强制签收只能申请平台审核 | Pass | Fulfillment DB + Merchant UI tests |
| 可用资产签名结算申请，商家不广播 EOA 转账 | Pass | Settlement DB/API/UI + 历史 BSC 结算收据 |

## 4. Platform Admin

| 真实操作 | 状态 | 必要证据 |
|---|---|---|
| 商家审核、商品审核及当前 RBAC | Pass | Core DB/API + Admin 169 tests |
| 风控、黑名单、限制、申诉和审计证据 | Pass | Risk DB/API + Admin UI tests |
| 接管履约、替代商家、强制确认 | Pass | Takeover/finality DB + Admin UI + combined E2E |
| 仲裁期间保留发货证据，裁决不跳过资金状态 | Pass | Arbitration DB/API/Admin tests |
| CMS 结构化表单、发布/回滚 | Pass | CMS DB/API/Admin tests |
| 系统配置结构化表单及二次签名 | Pass | Config DB/API/Admin tests |
| readiness 只返回非敏感 blocker，不放宽资金门禁 | Pass | Bootstrap/worker tests; 线上 `.17` 当前仍 fail closed |
| 审计查询与 hash chain | Pass | Audit DB/API/Admin tests |

## 5. 资金、秒杀与安全

| 不变量/链路 | 状态 | 必要证据 |
|---|---|---|
| 70% USDT + 30% 等值 NPL 精确报价 | Pass | Solidity + Core quote tests + 历史 BSC 证据 |
| 1% 服务费 / 69% 商家基础应收 / 独立运费 | Pass | 逐币种守恒与事件断言 |
| 20% NPL Burn / 10% NPL Reward / Router 零留存 | Pass | Contract invariant + 历史 BSC 证据 |
| Indexer 双 RPC、15 确认、分歧 fail closed | Pass | Worker/API tests + 历史链上证据 |
| BNM Locked -> Available，无链上 BNM/Claim | Pass | DB/adapter/consumer tests |
| `MERCHANT_USDT` 和 `REWARD_NPL` 逐笔 EOA 结算 | Pass | Settlement tests + 历史 BSC 15 确认收据 |
| 秒杀 60 分钟、60 秒接力、+30 秒与上限 | Pass | Contract/DB/Admin/Mall tests |
| 最后一笔有效订单候选、不换人审核、奖池结算/滚入 | Pass | Seckill DB/API/consumer tests |
| RBAC 和撤权旧 JWT 无法继续读写 | Pass | Auth/PII/fulfillment 负向测试 |
| PII 加密、当前权限复核、读取/导出审计 | Pass | DB/API tests |
| Circuit Breaker 暂停/恢复，履约/恢复/审计仍可用 | Pass | Contract/worker/DB tests + 历史 BSC 证据 |
| 业务/审计备份恢复与 audit hash chain | Pass | 生产加密备份已恢复验证；五条 audit stream 全部通过 |

## 6. Phase 2 与 External

| 项目 | 状态 | 边界 |
|---|---|---|
| 快递100 / 菜鸟 / 自动物流轨迹 | Phase2 | 不进入首发验收及 readiness |
| 电子面单 / 打印机 / 批量发货 | Phase2 | 首发生产 UI 无入口，底层历史契约保留 |
| GPS 最近门店 / 高德百度导航 | Phase2 | 不得阻断手工地址和履约 |
| 短信 / 邮件 / Push / OSS-CDN 真实账号 | External | 未配置时返回真实 `ConfigurationRequired` |
| 真实 1000 USDT 保证金主网动作 | External | 超出微额上限，不伪装执行 |

## 7. 历史链上证据复用边界

- `bcb999fb03dc` 是当前基线的祖先提交；从该提交到 `.18`
  未修改三份已部署合约、资金公式或 ABI。
- 已有 BSC Chain 56 证据可复用证明：普通支付、真实秒杀、
  Router 零留存、断路器暂停/恢复、`MERCHANT_USDT` 和 `REWARD_NPL`
  逐笔结算均达到 15 确认。
- 该证据不证明 `.18` 新增的手工地址、手工发货、备注/凭证和
  撤权后运单明文保护；这些必须使用当前源码的本地数据库、API、
  consumer 和浏览器测试验收。
- 本 Goal 不重复广播或扣款。

## 8. 发布门禁

| 门禁 | 状态 |
|---|---|
| 本清单所有本地首发项目为 `Pass` 或精确 `External` | Pass |
| 最终 `pnpm verify` 通过 | Pass |
| 线上 Core / 三端从 `.17` 发布为 `.18` | Pass |
| 发布后 `writesEnabled=true` 且 `runtimeBlockers=[]` | Pass |
| 生产 business/audit 备份完成并验证可恢复 | Pass |
| 旧物引用核对、隔离清理和清理后 `pnpm verify` | Pass |

当前线上 Core、EOA runtime、Mall、Merchant 和 Admin 均已发布为 `.18`。
公网 bootstrap 连续 600 秒的 121 个样本全部返回
`writesEnabled=true`、`runtimeBlockers=[]`。快递、打印和地图继续属于 Phase 2，
未配置不影响当前商城下单、支付和手工履约。
