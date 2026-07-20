# 24K商城 V2 旧物隔离清理报告

日期：2026-07-20
验收基线：`v2/core@79f93885d70f74fd21ef40d8d9e611263d6c23f2`
清理前验收提交：`49628ce413eb868fff9e95d43b316d6e3bd7e439`

## 结论

本次只清理了无引用占位代码、可重建构建产物、旧 release 包缓存和
已失效 worktree 元数据。真实链上收据、验收状态、旧部署证据、迁移、
V1 归档和独有 WIP 均未删除。

清理项通过 macOS `trash` 移出工程目录，没有对整个 `output/` 执行清理。
`output/` 从约 100 MiB 降为 504 KiB，本次共移出约 110 MiB 可重建文件。
最终 `pnpm verify` 从空缓存重建并验证了构建产物；门禁退出 0 后，本次新生成
的 ignored `dist/cache/out/test-results` 再次移出工程目录。这一操作不修改源码、
artifact 或历史证据。

## 已清理

| 类别 | 内容 | 引用核对与原因 |
|---|---|---|
| 无引用死代码 | `scripts/pending-gate.mjs` | Git/import/runtime/test/docs 无调用；仅为 4 行旧 fail-closed 占位 |
| 三端构建产物 | Mall/Merchant/Admin `dist/`，Mall `test-results/` | 均被 `.gitignore` 覆盖，tracked 文件为 0，可由构建/E2E 重建 |
| Foundry 构建产物 | `platform-v2/cache/`、`platform-v2/out/` | 被 `.gitignore` 覆盖，可由 `forge build/test` 重建 |
| 浏览器调试图 | `output/playwright/` | 无代码、测试或报告引用 |
| 旧 release 缓存 | 4 个 release 目录的 `static/`、source/static tar 和对应 `SHA256SUMS` | 对应提交均是 Core 祖先，可从 Git 重建；没有仓库外引用 |
| 失效 worktree 元数据 | `/private/tmp/abu24k-merchant-preview` | 实体目录已不存在，Git 标记 `prunable`；对应提交已在 Core 历史中 |

## 已保留

| 类别 | 内容 | 保留原因 |
|---|---|---|
| V1 历史 | `legacy/v1-npl-only/**` | 只读历史订单/审计证据，禁止在本 Goal 删除 |
| 迁移历史 | 38 个 business migration 及 artifact schema 副本 | 空库全量迁移和 append-only 审计链依赖 |
| 旧部署清单 | Safe superseded manifest、首个 EOA Router superseded manifest | 证明旧合约已从生产入口退役，不得抹除 |
| 主网私有证据 | `platform-v2/deployments/*private*.json` 和根 `output/` packet/receipt/runner | 可复核的部署、Policy、Router 切换和恢复证据 |
| release 验收证据 | 4 个 `output/releases/*/acceptance/`，共 26 个文件 | 支付、Indexer、履约、EOA 结算和 readiness 证据；权限仍为 `0600` |
| 当前产品 worktree | Mall/Merchant/Admin 三个 worktree | 每个分支相对 Core 仍有 1 个独有提交，不能清理 |
| 合约 WIP 归档 | `codex/archive-v2-contract-wip-20260714` | 唯一保存未合并的旧合约 WIP，不是生产路径 |
| 恢复锚点 | `rescue/parallel-v2-20260713-222206` 及已合并产品分支 refs | 不占用产品运行路径；保留用于本地恢复，不删 Git 历史 |

## 特别边界

- `SafeERC20` 是 OpenZeppelin ERC-20 转账库，不是 Safe 多签依赖，不清理。
- 旧 migration 中的 Safe 字段是 append-only 迁移历史，不按字符串删除。
- Router cutover 回执仍决定 `PAYMENT_INDEXER_START_BLOCK`，不移动、不删除。
- TWAP/Archive 的负向测试是“生产不依赖”的证据，不当作死代码。
- 快递100、电子面单、打印机、自动轨迹和地图仍为 Phase 2；本次没有删除其历史
  契约或新建替代系统。

## 验证状态

| 检查 | 状态 |
|---|---|
| 清理候选 Git/import/runtime/test/artifact/report 引用核对 | Pass |
| 私有 acceptance 证据文件数量与 `0600` 权限复核 | Pass |
| 三个有独有提交的产品 worktree 保留 | Pass |
| 清理后最小相关测试 | Pass：`baseline:check`、`requirements:check`、定向无引用检查 |
| 清理后最终 `pnpm verify` | Pass：退出码 0 |
