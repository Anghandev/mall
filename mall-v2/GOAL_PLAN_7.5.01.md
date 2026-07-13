# 阿步 24K 商城 PRD 7.5.01 Goal 计划

## 责任边界

本 Goal 只负责商城 C 端，目标工程是 `mall-v2/`。

商城负责：

- Expo/React Native 嵌入式 DApp 和 Web 预览。
- 秒杀大厅、常规商城、线下门店、我的资产四个 Tab。
- 商品、SKU、地址、配送/自提、订单、物流、售后申请、资产和 Claim 交互。
- 钱包连接、USDT/NPL allowance 和 Approve、交易广播、receipt/finality 状态。
- 商城消费的 API/ABI/状态机契约、fixtures 和联调验收。

商城不负责：

- 运营总后台、商家独立工作台、Solidity 合约、数据库、索引器、keeper 和多签执行器。
- 分账、销毁、奖池、退款、库存和仲裁的权威计算。前端只消费签名后的 quote/intent 和最终状态。

## 禁止触碰

以下是其他项目或历史系统，本 Goal 只读联调契约，不编辑、不移动、不删除：

- `platform-v2/`（运营总后台/平台项目）
- `merchant-v2/` 或后续确定的商家工作台目录
- `legacy/`（旧 NPL-only 一体化系统）
- 根目录中由其他项目线产生的 Git 变更

可以只读参考 `legacy/v1-npl-only/` 的品牌资产和 C 端交互，但 `mall-v2` 不得 runtime import `legacy` 或复制 NPL-only 口径。

## 权威与红线

1. 用户附件《阿步 24K 商城需求文档（PRD）第 7.5.01 版》是商城的唯一新产品基线。
2. PRD 内部冲突不在前端猜测；它们进入上游契约问题表。
3. 不部署合约/后端，不发主网交易，不运行主网微测。
4. 不读取、输出、提交或传递 `PRIVATE_KEY`、助记词和 provider secret。
5. 不在前端计算分账、退款、奖池、BNM 产出或中奖结果。
6. 不把 TxHash 返回当成成功；状态分为 `awaiting-wallet / submitted / confirming / finalized / reverted / replaced`。
7. fixtures 必须明确标记，生产构建禁用，不用本地数据冒充链上成功。

## Phase 0：商城矩阵与上游契约

产出：

- `docs/requirements/PRD-7.5.01.txt`：原文与 SHA-256。
- `docs/requirements/REQUIREMENTS_MATRIX.md`：只收录 C 端页面、钱包、交易、订单、履约展示、售后申请、资产和联调需求。
- `docs/contracts/UPSTREAM_API.md`：endpoints、WebSocket events、错误码、幂等和 finality 语义。
- `docs/contracts/UPSTREAM_WEB3.md`：chainId、token/合约地址、allowance、calldata、receipt/event 和 Claim 契约。
- `docs/contracts/OPEN_QUESTIONS.md`：只列会改变商城展示或交易步骤的未定口径。

商城要求上游提供：

1. SKU 的精确 USDT/NPL 整数报价、decimals、quote/policy version 和过期时间。
2. 可签名库存 reservation；只读预检不作为防超卖证明。
3. 订单、秒杀、奖池、BNM 和各收益的权威状态。
4. 退款/强制签收/换货/延期的 eligibility、clock、reason 和 allowedActions。
5. `Locked / Available / PendingClaim / Claimed / Burned / Refunded` 的分资产精确金额。

验收：每项商城需求都有 PRD 行号、UI 标准和 fixture/联调证据；平台或商家后台实现不进入商城矩阵。

## Phase 1：独立商城工程

1. 建立独立 `package.json`、`app.json`、`tsconfig.json`、`src/`、`assets/`、`tests/` 和 `scripts/`。
2. 不依赖 `../legacy`、`../platform-v2` 或商家工程源码；联调只通过 HTTPS/WSS 和版本化契约。
3. 使用已有 Expo/React Native/Reown/ethers/Lucide 技术栈，不运行覆盖式初始化 CLI。
4. 建立设计 tokens、safe-area 布局、四 Tab、错误边界、断网/慢网和明确 fixture 模式。

预期脚本：`typecheck`、`requirements:check`、`app:check`、`api-contract:check`、`screenshots:check`、`verify`。

## Phase 2：类型、API 客户端与 fixtures

1. 从上游 OpenAPI/types 生成或审阅后引入类型，禁止前端私自扩展资金字段。
2. 统一 client 处理 API base URL、buyer SIWE、超时、重试、取消、幂等 key、错链和可观测错误。
3. WebSocket 支持断线重连、游标补拉、顺序去重和轮询降级。
4. fixtures 覆盖空、加载、错误、无钱包、错链、拒绝、pending、replaced、reverted 和 finalized。

验收：schema 负测试、未知 enum 安全降级、重放不重复下单，生产构建不可启用 fixtures。

## Phase 3：四 Tab 业务界面

### 秒杀大厅

- `PREHEAT / LIVE / SETTLING / SETTLED`、主/接力双倒计时、奖池、规则、历史战报和滚动墙。
- 结算期禁止下单；结算后普通/中奖战报和 USDT 领奖导流。
- 30 秒特效有 reduced-motion 和静态结果降级。

### 常规商城

- 横向分类、商品流、BNM 标识、秒杀遮罩、商品详情和常驻购买栏。
- SKU、数量、配送/自提底部选单，库存预检和五要素终核。
- 双币金额只展示上游 quote，不用浮点数重算。

### 线下门店

- 国家/城市/区县联动、GPS 距离、最近可用门店默认。
- 门店详情、营业时间、原生拨号和高德/百度导航。

### 我的资产

- 个人信息、地址解析/复核/CRUD、四类订单分组和物流摘要。
- 秒杀参与和常规消费双轨记录。
- BNM、创世节点、直推店铺、地域代理、运维收益五个板块，每个显示累计/待领取/锁定中。
- 只渲染上游 `allowedActions`，不以本地时间自行开启退款或强制签收。

## Phase 4：钱包与交易流

1. 连接/断开/换账户，错误 chainId 明确阻断。
2. 对 USDT 和 NPL 分别检查 allowance，仅对不足 token 请求 Approve；显示 spender、额度和撤销入口。
3. 按上游 intent 顺序发送 Approve/payment/recordPurchase/complete/claim，前端不自建 calldata。
4. 处理用户拒绝、nonce 冲突、交易替换、revert、RPC 失败和 finality，App 重启后可继续。
5. 只在最终确认后更新订单/资产，展示完整 TxHash 和链上跳转。

## Phase 5：视觉与设备验收

- 秒杀可更有活动感；订单/资产保持清晰、紧凑、易对账。
- 使用 Lucide，不依赖 emoji 作为操作图标，不使用嵌套卡片或套模板黑金界面。
- 44x44 触摸目标、safe area、动态字号、色彩非唯一状态信号、金额/倒计时等宽数字、reduced motion。
- 检查 375x812、393x852、768 宽平板和桌面 Web，无重叠、溢出、横向滚动或底栏遮挡。
- 覆盖慢网、断网、空数据、API 失败、长地址、大金额、大字体和低性能设备。

自动化：`pnpm typecheck && pnpm requirements:check && pnpm api-contract:check && pnpm app:check && pnpm screenshots:check`。

真机钱包、GPS、拨号、导航和生产 HTTPS/WSS 联调未就绪时标为 `ExternalBlocked`，不伪造 PASS。

## Phase 6：三项目联调

1. 固定 OpenAPI/types/ABI 版本并运行 consumer contract tests，上游破坏性变更必须明确失败。
2. 按 `商城操作 -> 上游请求/事件 -> 商城最终状态` 记录联调，不进入其他工程修实现。
3. 输出商城交接包：环境变量名称、契约版本、状态矩阵、真机 checklist、截图和外部阻塞。

## 成功标准

- `mall-v2/` 独立可运行、可测试、可打包，对其他项目无源码级运行依赖。
- PRD 7.5.01 的四 Tab、下单、售后申请、订单、资产和钱包状态有可追溯需求与测试证据。
- 商城不计算资金真值，不显示假成功，不在 finality 前改写资产。
- 上游契约缺失时 fail closed，稳定显示不可用原因。
- 手机/平板/Web 无重叠、溢出、不可点或 safe-area 遮挡，支持大字体和 reduced motion。
- 本 Goal 只变更 `mall-v2/`，不提交密钥，不部署合约/后端，不发主网交易。

## 稍后启动 Goal 的目标文本

> 执行 `/Users/ronnie/Desktop/代码/商城/mall-v2/GOAL_PLAN_7.5.01.md`。你只负责商城 C 端，所有变更限定在 `mall-v2/`。`platform-v2/`、商家工作台目录、`legacy/` 和根目录其他变更均禁止编辑。以 PRD 7.5.01 为商城唯一新产品基线，先建立商城需求矩阵和上游 API/Web3 契约，再用独立 Expo/React Native 工程完成四 Tab、双币钱包交易、订单/售后/资产展示和设备验收。商城不实现合约、数据库、索引器、商家/运营后台或资金公式；只消费版本化上游契约，缺失时 fail closed。禁止部署、主网交易、主网微测、输出私钥或运行无关安装/发布脚本。
