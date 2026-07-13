# 24K 真机 UX 结果记录

| # | 场景 | 期望 | 结果 | 备注 |
|---|---|---|---|---|
| 1 | 四页渲染与底部栏 | `秒杀大厅 / 常规商城 / 线下门店 / 我的资产` 都能打开，底部栏不被遮挡 | TODO | TODO |
| 2 | 秒杀大厅 | 倒计时、接力 +30s、奖池、规则、战报、终核入口均可用 | TODO | TODO |
| 3 | 常规商城 | SKU、数量、快递/自提、地址/门店、库存复核、5 要素终核可用 | TODO | TODO |
| 4 | 线下门店 | 地区筛选、GPS 距离、拨号、导航、行政区编码展示可用 | TODO | TODO |
| 5 | 我的资产 | BNM/节点/直推/区域/运维池、三态账本、Claim paused 可用 | TODO | TODO |
| 6 | 钱包连接 / Account / 断开 | Reown Connect / Account / 断开流程正常 | TODO | TODO |
| 7 | 非 BSC 切链 | 请求切到 BSC 56，失败有提示 | TODO | TODO |
| 8 | NPL 授权 | NPL allowance 不足时发送一笔无限授权，充足时跳过 | TODO | TODO |
| 9 | 拒签 approve | 显示本订单未付款，不进入 fund | TODO | TODO |
| 10 | approve 成功但 fund 拒签 | 显示未付款/可恢复，不标记 PaidLocked | TODO | TODO |
| 11 | pending / 重开恢复 | 重开后按钱包地址恢复订单状态 | TODO | TODO |
| 12 | 微额成功支付 | 极小金额完成真实 BSC NPL approve 与 payOrder 路径 | TODO | TODO |
| 13 | 商家后台 | `/merchant` 模块完整展示 | TODO | TODO |
| 14 | 平台后台 | `/admin` 模块完整展示 | TODO | TODO |

## Playwright 浏览器证据（不替代真机钱包验收）

- 2026-07-13：C 端四页在 `1440x1000` 和 `390x844` 均完成渲染，无 console error，手机宽度下 `scrollWidth === clientWidth`。
- 商品详情已验证：选择 `曜金 256G`、数量 `2` 后，终核区显示 `曜金 256G × 2` 和 `938.00 NPL · 100% NPL`；库存复核与加入终核清单均有状态反馈。
- `/merchant` 与 `/admin` 的 SIWE 登录门禁在桌面和手机宽度均完成渲染；未使用伪造钱包会话绕过登录。
- 截图：`test-artifacts/screenshots/contact-sheet.png`、`test-artifacts/screenshots/mobile-product-final-check.png`。
- 上述证据只覆盖浏览器布局与交互。Reown、BSC 切链、拒签恢复和真实 NPL 交易仍必须在真实手机钱包完成后才能把表格结果改为 PASS。
