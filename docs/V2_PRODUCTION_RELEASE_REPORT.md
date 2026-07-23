# 24K商城 V2 生产发布报告

> Historical `.18` release snapshot only. It is retained as immutable evidence
> of that deployment and does not establish Go for artifact `.29`, the current
> commit, the three-buyer mainnet run or the next production release.

日期：2026-07-20
发布提交：`a1c00261dc279af876407bf083e6540312d6da8e`
Core artifact：`2.0.0-fulfillment-launch.18`
生产入口：`https://www.npleon.com/{mall,merchant,platform,core}`

## 结论

`.18` 在 2026-07-20 当时的发布验收为 `Go`，但该结论已被当前
`.29` 发布目标取代，不能作为当前 Go 证据。当前 `.29` artifact Go 已由
非零奖池主网微测、cleanup gate、完整本地 release gate 和授权 manifest 证明；
线上生产发布/600 秒观察必须另以 `.29` 运行态证据记录。

## 数据与迁移

- production business 和 audit 已生成加密备份，密文及 checksum 权限均为
  `0600`。
- 两份备份已恢复到隔离数据库并完成校验；恢复副本的 business migration
  为 38、audit migration 为 4。
- `038_manual_fulfillment_launch.sql` 在恢复副本和正式 business 数据库均
  恰好出现一次。
- 恢复副本和生产 audit hash chain 均通过；生产复核时 governance 为
  14,797 条，operational 为 454 条，其余 stream 为空且有效。
- 两个恢复临时数据库和服务器临时解密环境文件已删除；加密备份与本机
  `0600` 解密密钥保留。

## 发布结果

- Core 和 EOA runtime 运行镜像均为 `abu24k-core:a1c00261dc27`，发布后
  0 次重启。
- Mall、Merchant、Admin 的 18 个线上静态文件与本地 release 包逐文件
  完全一致。
- production bundle 未发现 fixture marker；正式业务库没有商家、商品、
  订单、支付事件或待结算任务。
- 发布前后政策、熔断、秒杀和结算执行队列均为空，没有触发 EOA 广播。

## Readiness 与 Smoke

- 公网 `/core/v2/bootstrap` 连续 600 秒、每 5 秒采样一次，共 121 个样本。
- 121/121 均为 HTTP 200、artifact `.18`、`writesEnabled=true`、
  `runtimeBlockers=[]`。
- 公开 catalog、store、CMS 和秒杀历史读取正常；无活动秒杀场次时按契约
  返回 404。
- Buyer、Merchant、Admin 受保护读取在无 token 时均返回 401。
- 三端真实浏览器加载成功，无页面异常、请求失败或横向溢出；Mall 唯一
  控制台 404 对应“当前无秒杀场次”的预期请求。
- audit outbox 启动事件已正常送达，最终积压为 0；生产 audit hash chain
  全部有效。
- Core、EOA runtime 和 Nginx 在稳定观察窗口内没有错误日志。

## 资金边界

本次发布没有重新部署合约、发布 Policy、执行 approve、创建支付、创建结算
或发送任何 BSC 交易。`.18` 未修改 PaymentRouter、支付公式、Indexer 或 EOA
结算逻辑，继续复用已完成的 Chain 56 普通支付、秒杀、Breaker 和双资产结算
证据。

## 脱敏证据

- Release manifest：`output/releases/a1c00261dc27/release-manifest.json`
- Readiness observation：
  `output/releases/a1c00261dc27/acceptance/production-readiness-observation-private.jsonl`
- Observation SHA-256：
  `e51ad2a9a6432b25439a57de2614061ba93230ad005cedc5ff35128baaf29bc4`
- Production smoke：
  `output/releases/a1c00261dc27/acceptance/production-smoke-private.json`
- Smoke SHA-256：
  `b9b23c75d009e20bd28fb25bea91a7abb9589573c5eae68034cbff2c97116acf`
- 浏览器截图：`output/playwright/a1c00261dc27/`

上述原始 observation、截图、备份密钥和服务器备份不进入 Git。
