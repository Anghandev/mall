# 阿步 24K 商城 PRD 7.5.01 Goal 执行计划

## 1. Goal 目标

以《阿步 24K 商城需求文档（PRD）第 7.5.01 版》为新的唯一产品基线，将当前 NPL-only 商城迁移为符合 7.5.01 的 USDT + NPL 双资产支付、资金冻结/解冻、秒杀奖池、订单履约、仲裁和多角色 Claim 系统。

这是资金模型和全链状态机迁移，不是前端换文案。Goal 要覆盖合约、数据库、索引器、API、C 端、商家后台、运营后台和验收门禁。

## 2. 权威与冲突优先级

1. 新权威来源：用户附件 `pasted-text.txt` 中的 PRD 7.5.01。Goal 开始后将其原样纳入 `docs/requirements/` 并记录 SHA-256。
2. PRD 第 4 行的版本摘要和 5.1 状态机高于中间的展示性文案，但不得用这条自行补齐未给出的百分比或退款公式。
3. 当前 `README.md`、`docs/REQUIREMENTS_MATRIX.md`、`docs/CONTRACT_FREEZE.md` 和青雀需求只是历史基线；其中的 NPL-only Goal override 不再有效。
4. 旧数据库 migration 和 Git 历史不删除。冲突文档先归档隔离，活跃运行码在新门禁全通过后再清除。

## 3. 当前基线

- Git 基线：`main` @ `43ea7c9`，检查时工作区干净。
- 架构：Expo/React Native C 端 + Node/SQLite API + 商家/运营后台 + Foundry 合约 + 链上事件索引器。
- 当前支付链：`SIWE -> 库存预检 -> 五要素终核 -> NPL approve/payOrder -> OrderPaid finality -> 履约 -> completeOrder`。
- 当前矩阵：146 项，`Done 83 / Partial 23 / Missing 6 / ExternalBlocked 34`，但这个矩阵主动把 USDT 要求覆盖成了 NPL-only。
- 计划阶段已验证：`pnpm typecheck`、`pnpm contracts:test` (19/19)、`pnpm requirements:check`、`pnpm backend:check` 通过。它们证明旧基线稳定，不证明 7.5.01 已满足。

## 4. Goal 红线

- 不自动部署、不发主网交易、不运行主网微测。这些必须由用户在所有本地门禁通过后单独授权。
- 不读取、输出、提交或传递 `PRIVATE_KEY`、助记词和 provider secret。
- 不在分账比例、币种基数、退款公式、秒杀边界价格上猜测。P0 有空白就停在文档阶段。
- 不把资金先转给 EOA 再声称“合约冻结”。`Locked` 代表资金仍由合约托管，只建立 beneficiary 权益。
- 不把 TxHash 返回当成支付成功。只有 receipt `status=1` 且达到规定确认数才改变权威业务状态。
- 不依赖只读库存查询防超卖。预检只服务 UX，最终付款必须绑定不可重放的库存预占并原子消耗。
- 新增第三方依赖前先审计必要性、许可和依赖树；不运行覆盖式 CLI 或安装脚本。

## 5. Phase 0：P0 真值表与停止门

Goal 先完成下表，并写入 `docs/requirements/PRD-7.5.01-DECISIONS.md`。任一项没有明确值时，可继续做无资金副作用的矩阵/原型工作，但禁止进入合约 ABI 改造。

| ID | 必须确认的真值 | 建议默认口径 |
|---|---|---|
| D-01 | 第 4 行“用户收款”是否指“用户收货” | 按“确认收货/自提核销/仲裁完成”解锁 |
| D-02 | 各资产冻结范围 | 除已结算秒杀奖池和明确不可逆销毁外，货款与各角色收益全部先 `Locked` |
| D-03 | 每个 SKU 的 USDT/NPL 价格、精度、币种地址和价格版本 | 后端签名固化双币精确整数量，前端不自算比例 |
| D-04 | 商家、创世 2%、直推 1%、地区 1.2/0.8/0.6/0.4%、运维 4%、奖池、销毁 20% 分别按哪个币种/基数计算 | 建立版本化 `SettlementPolicy`，每资产独立守恒，明确舍入和余数归属 |
| D-05 | 常规单/秒杀单 7 天未发货的退款公式，以及 20% 销毁与退款的关系 | 无理由退款禁止，商家违约强制退款是独立例外；未书面确定公式不做不可逆转账/销毁 |
| D-06 | 秒杀主倒计时/接力倒计时的终止条件，边界单价差和奖池贡献 | 由唯一链上判定函数分类，前端只展示结果 |
| D-07 | BNM 1:1 按 USDT、NPL 还是总消费价值计算 | 付款后只生成 `Locked BNM entitlement`，履约完成后转 `Available` |
| D-08 | 未发货/未签收的 7 天起点、举证和执行人 | 未发货从付款最终确认起算；未签收从物流送达/自提可取证据起算；商家只申请，仲裁角色执行 |
| D-09 | 库存权威点 | 短 TTL 预占 + 订单签名绑定 + 付款时原子消耗，过期自动释放 |
| D-10 | 多受益人、创世凭证、直推关系、四级地域和运维权重的快照时点 | 付款授权中固化 policyVersion 与 beneficiary snapshot，事后不因身份转移改写旧单 |
| D-11 | 奖池资产、来源、无人参与处理和中奖算法 | PRD 的 USDT 奖金在结算后变 `Available`，由中奖者 Pull Claim，不直推 EOA |
| D-12 | 旧未完成订单/奖励是继续走 v1 还是迁移 | 已付款 v1 订单不原地改语义；v2 新合约/新 policy 只接新单，后台同时展示并对账 |

Phase 0 产物：

- `docs/requirements/PRD-7.5.01.txt`
- `docs/requirements/PRD-7.5.01-DECISIONS.md`
- 重建的 `docs/REQUIREMENTS_MATRIX.md`，每项带 PRD 行号、验收标准、代码/测试证据和阻塞项
- `docs/archive/pre-7.5.01/README.md`，列出被取代的青雀、NPL-only 和旧 freeze 文档
- 资金守恒表、状态机、权限矩阵、链上/链下边界图

验收：`pnpm requirements:check`，且新矩阵不得再包含 USDT -> NPL-only 覆盖。

## 6. Phase 1：合约 v2，测试先行

1. 先写失败测试和资金不变式，再改 ABI。不在 v1 ABI 上堆叠无法审计的兼容参数。
2. 双资产支付：签名授权固化 USDT/NPL 整数量、SKU、数量、履约模式、地域编码、库存预占、policyVersion 和截止时间。
3. 将货款和各角色收益建模为托管合约中的 beneficiary ledger：`Locked -> Available -> Claimed`，支持 USDT/NPL/BNM 分资产对账。
4. 秒杀奖池使用 P0 确认的 USDT 来源，活动 `SETTLING -> SETTLED` 后中奖权益立即 `Available`，领奖仍为 Pull Claim。
5. 将发货/送达/自提核销/仲裁证明纳入合约授权边界。买家不能在 `PaidLocked` 后跳过履约直接 `completeOrder`。
6. 退款按 P0 的分资产公式原子执行，同时撤销未释放权益。已进入奖池的秒杀贡献不得重复返回或重复计奖。
7. 异步“次区块”通过显式 keeper/settler 交易实现，包含最早块高、幂等 key、重试、Gas 上限和失败恢复；不使用“合约自动在下一块执行”的假设。
8. 移除 `tx.origin == msg.sender` 式的伪防闪电贷限制。安全性由状态机、资金守恒、不可同交易 Claim 和延迟结算保证，同时保留 Safe/智能账户兼容性。
9. 限制单订单 beneficiary/reward entry 数量，或将释放/退款改为可分页的常数复杂度路径，避免无界数组循环导致 Gas DoS。
10. 保留透明 Circuit Breaker：支付、新场次、普通结算和 Claim 可分域暂停；应急退款/资金救援可用；仅多签角色可触发/恢复，并发出事件。

必测场景：双 Approve/已授权跳过、双币手续费型 token 拒绝、重放、超卖、边界块、退款后不得中奖/领奖、重复 Claim、精度/舍入、每资产守恒、权限失败、暂停、暂停中恢复、恢复后继续。

验收：`pnpm contracts:test && pnpm contracts:freeze-check`。输出新 ABI hash、事件表和部署顺序，但不部署。

## 7. Phase 2：数据库、索引器与结算作业

1. 新增 forward-only schema v3，不改写/删除 v1/v2 migration。
2. 订单显式存储双资产金额、支付/发货/送达/核销/完成时钟、秒杀贡献、policyVersion 和不可变 beneficiary snapshot。
3. 权益账本显式存储 `role + beneficiary + asset + amount + state + orderId + policyVersion`，不再从 `source` 文本正则推断业务角色。
4. 新增库存预占、结算 outbox/jobs、幂等 key、失败重试和人工处置队列。
5. 索引器以链上新事件为权威信号，保留当前 finality、重组检测、去重和追加式审计。
6. v1/v2 数据双读与对账：旧订单按旧语义完结，新订单不回写旧字段作为权威值。

验收：`pnpm database:check && pnpm backend:check && pnpm e2e:local`，另加 migration 中断/重跑、旧数据双读、资金对账和 keeper 失败恢复测试。

## 8. Phase 3：API 与端到端业务状态机

1. `final-check` / `checkout-intent` / `seckill-intent` 返回双资产精确报价、双 allowance 步骤、库存 reservation 和新合约 calldata；前端不自行构造。
2. 订单内部细状态覆盖 `PaymentPending / PaidLocked / AwaitingShipment / Shipped / AwaitingPickup / Arbitration / Completed / Refunded`，再映射到 PRD 的四个 UI 分组。
3. 实现商家 7 天强制签收申请、买家 7 天未发货退款申请、换货/延期仲裁，并保证申请和链上执行是两个可审计阶段。
4. 秒杀 `PREHEAT -> LIVE -> SETTLING -> SETTLED` 只由区块时间、receipt 和 finality 推进；退款单不得保留中奖资格。
5. 用真正的 WebSocket 补充 PRD 实时流，并保留可审计的断线补拉/轮询降级。如需新增 `ws` 类依赖，先审计再修改 lockfile。
6. 每日对账 USDT、NPL、BNM 的合约余额、Locked、Available、Claimed、Refunded/Burned 总额；不守恒立即告警并停止新支付。

验收：`pnpm backend:check && pnpm dapp:check && pnpm e2e:full && pnpm server:ops-check`。

## 9. Phase 4：C 端四 Tab 完整落地

保留现有 Expo/React Native 与四 Tab 架构，不重写整个 App。资产/订单界面保持安静、高密度、易对账；秒杀界面可更具活动感，但状态和金额永远优先。

1. 秒杀：四阶段、双倒计时、规则确认、历史战报、滚动墙、结算期锁定、30 秒战报、中奖特效和 USDT Claim 导流。必须有 reduced-motion 降级，不用动画阻断无障碍操作。
2. 商城：横向分类、秒杀遮罩、BNM 标识、商品详情常驻购买栏、SKU/数量/配送/自提底部选单和五要素终核。
3. 门店：国家/城市/区县联动、GPS 距离、最近可用门店默认、拨号和高德/百度导航唤起。
4. 资产：地址仓、四类订单分组、物流摘要、秒杀角标、双轨记录，以及 BNM + 创世 + 直推 + 地区 + 运维的明确五个对账板块。
5. 钱包：两个 token 分别检查 allowance，仅对不足的 token 请求 Approve；显示 spender/额度/撤销入口。不得显示“免密”误导用户。
6. 所有 pending/replaced/reverted/finality 状态都有独立视图，不得使用假成功或本地伪造资产。

UI 门禁：44x44 触摸目标、安全区、动态字号、色彩不是唯一状态信号、金额/倒计时等宽数字、不嵌套卡片、不重叠、不溢出、不依赖 emoji 作为操作图标，优先现有 Lucide。

验收：`pnpm typecheck && pnpm app:check && pnpm dapp:frontend-check`；再用真实浏览器/设备检查 375x812、393x852、768 和桌面 Web 宽度，覆盖慢网、断网、长地址、大金额、系统大字体和 reduced motion。

## 10. Phase 5：商家/运营后台的必要能力

只补齐 7.5.01 运行闭环必需的后台，不扩展无关 CRM 或营销功能：

- 商家：双币订单、发货、自提核销、强制签收申请、货款 `Locked/Available/Claimed` 和失败 Claim 恢复。
- 运营：版本化报价/分账 policy、多受益人与权重、秒杀场次/奖池、仲裁、强制退款/签收、keeper 队列、链上对账、Circuit Breaker 和多签执行状态。
- 所有高风险写操作继续使用 SIWE + 二次签名 + 追加式审计；API 不保存 owner/deployer 私钥。

验收：`pnpm e2e:full && pnpm server:ops-check`，并通过买家、商家、仲裁员、运营多签和无权地址的正反权限测试。

## 11. Phase 6：隔离与清除旧口径

1. 将青雀/NPL-only/旧 freeze 文档移到 `docs/archive/pre-7.5.01/`，并在文件头标记“仅历史，不得作为当前实现依据”。
2. 清除活跃路径中的 `NPL-only`、`100% NPL`、单 `amount_npl`、`prizePoolNpl`、旧单币 ABI、旧 OpenAPI/SDK/types 和与新 PRD 冲突的 UI 文案。
3. 重新生成 ABI/OpenAPI/SDK/交接包，不手工修改生成物。
4. 保留 Git 历史、v1 合约源码/已部署地址记录和旧 DB migration，以支持存量单查询与对账。

零残留检查必须结合允许清单：归档目录和 v1 兼容读取层可出现旧词，新订单路径、公开文档、新 ABI 和新测试中不得出现。

验收：`pnpm audit:mvp && pnpm requirements:gate`，以及受控 `rg` 残留扫描。

## 12. Phase 7：最终验收与发布准备

本地全门禁：

```bash
pnpm typecheck
pnpm contracts:test
pnpm contracts:freeze-check
pnpm database:check
pnpm backend:check
pnpm server:ops-check
pnpm dapp:check
pnpm dapp:frontend-check
pnpm app:check
pnpm e2e:local
pnpm e2e:full
pnpm audit:mvp
pnpm requirements:gate
```

成功标准：

- 7.5.01 矩阵中所有非外部依赖项均为 `Done`，每项有真实代码和测试证据。
- USDT/NPL/BNM 分别资金守恒，无双花、重复 Claim、退款后领奖或先收款后超卖。
- 货款和各角色收益在履约完成前确实由合约托管为 `Locked`，仲裁中不可 Claim。
- 买家 7 天未发货退款、商家 7 天强制签收申请、换货/延期和应急暂停/恢复有完整正反测试。
- C 端四 Tab 在手机、大字体、慢网、断网和 reduced-motion 下无重叠/溢出/假成功。
- 旧 NPL-only 口径只存在明确归档和 v1 兼容读取层。
- 工作区只包含本 Goal 可追溯变更，无密钥、无主网交易、无未授权部署。

`pnpm dapp:strict-gate -- --strict`、真机钱包/GPS/拨号/导航验收、BSC 超小额微测和任何部署属于外部发布门，只在用户单独授权、RPC/多签/地址/provider 输入齐全后执行。

## 13. 稍后启动 Goal 时的目标文本

> 执行 `/Users/ronnie/Desktop/代码/商城/GOAL_PLAN_7.5.01.md`。以 PRD 7.5.01 为唯一新产品基线，从当前干净提交 `43ea7c9` 创建 `codex/prd-7.5.01` 分支。先完成 Phase 0 的需求真值表、资金守恒表、状态机、权限矩阵、新需求矩阵和旧基线隔离。P0 任一资金口径不明确时停在合约改造前，列出唯一需要用户确认的决策，不猜数字。全程保留 Git 历史和旧 DB migration，使用测试先行的双资产合约/数据/API/UI 迁移，逐阶段运行计划中的窄门禁。禁止部署、主网交易、主网微测、输出私钥或运行无关安装/发布脚本。
