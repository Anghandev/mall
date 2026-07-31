import { artifactVersion, chainIdentity } from '@abu24k/core-artifacts';
import { capabilityStatus, deploymentAuthorized, publicationStatus } from '@abu24k/core-artifacts/manifest';
import { Ban, CheckCircle2, CircleDot, RadioTower, RefreshCw, ShieldCheck } from 'lucide-react';
import { fetchCoreBootstrap } from '../coreApi';
import { useCoreResource } from '../useCoreResource';

export function CoreStatusPage() {
  const bootstrap = useCoreResource(fetchCoreBootstrap);
  const readiness = bootstrap.data?.readiness;
  const connected = !bootstrap.loading && !bootstrap.error && bootstrap.data?.status === 'CORE_API_READY';

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><RadioTower aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">系统状态检查</p>
          <h1>系统状态</h1>
          <p>版本、接口能力和运行状态均来自同一发布物。未部署、未配置或未发布不会显示为健康。</p>
        </div>
        <div className="requirement-list"><code>运行检查</code></div>
      </header>

      <section className="status-overview" aria-label="系统发布状态">
        <article>
          <span>系统状态</span>
          <strong>{bootstrap.loading ? '检查中' : connected ? '系统已连接' : '后台服务不可用'}</strong>
          <small>{connected ? publicationLabel(publicationStatus) : bootstrap.error ? errorLabel(bootstrap.error.code) : '等待后台返回'}</small>
          <details className="technical-details compact"><summary>版本信息</summary><code>{artifactVersion}</code></details>
        </article>
        <article><span>运行网络</span><strong>BSC 主网</strong><small>平台正式运行网络</small><details className="technical-details compact"><summary>网络编号</summary><code>{chainIdentity.chainId}</code></details></article>
        <article><span>部署状态</span><strong>{deploymentAuthorized ? '已授权' : '暂未就绪'}</strong><small>没有地址时不推断</small></article>
        <article>
          <span>新付款</span>
          <strong>{bootstrap.loading ? '检查中' : bootstrap.error ? '未返回数据' : readiness?.writesEnabled ? '已开启' : '安全关闭'}</strong>
          <small>{bootstrap.error ? errorLabel(bootstrap.error.code) : readiness ? '系统确认' : '无运行证据'}</small>
        </article>
      </section>

      <section className="status-columns">
        <article className="panel">
          <div className="panel-heading">
            <div><p className="section-kicker">运行状态</p><h2>支付运行状态</h2></div>
            <button className="button button-quiet" type="button" onClick={bootstrap.reload} disabled={bootstrap.loading}>
              <RefreshCw aria-hidden="true" /> {bootstrap.loading ? '检查中' : '重新检查'}
            </button>
          </div>
          {bootstrap.error ? (
            <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{errorLabel(bootstrap.error.code)}</strong><p>{humanStatusError(bootstrap.error.message)}</p></div></div>
          ) : null}
          {readiness ? (
            <dl className="definition-grid">
              <div><dt>系统状态</dt><dd>{statusLabel(bootstrap.data?.status)}</dd></div>
              <div><dt>运行网络</dt><dd>BSC 主网<details className="technical-details compact"><summary>核验编号</summary><code>{readiness.chainId}</code></details></dd></div>
              <div><dt>新支付写入</dt><dd>{readiness.writesEnabled ? '已开启' : '安全关闭'}</dd></div>
            </dl>
          ) : null}
          {readiness ? (
            <details className="technical-details">
              <summary>配置明细</summary>
              <dl className="definition-grid">
                <div><dt>USDT 合约</dt><dd><code>{readiness.assets.usdt}</code></dd></div>
                <div><dt>NPL 合约</dt><dd><code>{readiness.assets.npl}</code></dd></div>
                <div><dt>NPL / USDT 交易对</dt><dd>{readiness.assets.nplUsdtPair ? <code>{readiness.assets.nplUsdtPair}</code> : '未公开'}</dd></div>
              </dl>
            </details>
          ) : null}
        </article>

        <aside className="panel">
          <p className="section-kicker">系统能力</p><h2>系统全局发布面</h2>
          <ul className="capability-list">
            {Object.entries(capabilityStatus).map(([name, status]) => (
              <li key={name} className={status === 'AVAILABLE' ? 'capability-available' : 'capability-blocked'}>
                {status === 'AVAILABLE' ? <CheckCircle2 aria-hidden="true" /> : <CircleDot aria-hidden="true" />}
                <span><strong>{capabilityLabel(name)}</strong><small>{status === 'AVAILABLE' ? '已发布' : '未发布'}</small></span>
              </li>
            ))}
          </ul>
        </aside>
      </section>

      <section className="status-columns">
        <BlockedList title="运行限制" values={readiness?.runtimeBlockers} loading={bootstrap.loading} />
        <BlockedList title="付款规则限制" values={readiness?.paymentDecisionBlocked} loading={bootstrap.loading} />
        <BlockedList title="付款服务未就绪" values={readiness?.paymentExternalBlocked} loading={bootstrap.loading} />
      </section>

      <section className="snapshot-rule">
        <ShieldCheck aria-hidden="true" />
        <div><strong>后台边界</strong><p>物流配置、面单、打印、检索、资源导出、商品标签和商家审核功能已发布。手机号、特殊队列和生产部署仍保持安全关闭。</p></div>
      </section>
    </>
  );
}

function capabilityLabel(name: string) {
  return ({
    siweAuthentication: '钱包登录认证',
    orderAllowedActions: '订单可用操作',
    catalogHttp: '商品读取',
    catalogManagementHttp: '商品管理',
    signedConcessionPreview: '让利预览签名',
    mediaHttp: '媒体上传读取',
    merchantProfileHttp: '商家资料',
    fulfillmentHttp: '履约操作',
    takeoverHttp: '接管履约',
    settlementHttp: '结算读取',
    adminHttp: '平台后台',
    auditHttp: '审计日志',
    notificationsHttp: '消息通知',
    monitoringHttp: '运维监控',
    immutableMediaEvidence: '媒体证据封存',
    paymentQuoteHttp: '付款报价',
    inventoryReservation: '库存预留',
    paymentSubmissionHttp: '支付提交',
    paymentProjectionHttp: '支付预览',
    paymentIndexer: '支付确认',
    settlementEoaTransfers: '结算转账',
    buyerShoppingStatementHttp: '买家购物明细',
    merchantReceivableStatementHttp: '商家应收明细',
    guaranteeDepositHttp: '历史资金记录读取',
    guaranteeDepositFinality: '历史资金最终确认',
    takeoverFundingHttp: '接管资金',
    takeoverCaseManagementHttp: '接管案件',
    replacementMerchantFulfillment: '替代商家履约',
    policyGovernanceHttp: '政策治理',
    cmsHttp: '内容管理',
    notificationDelivery: '通知投递',
    systemConfigGovernanceHttp: '系统配置治理',
    buyerAccountHttp: '买家账户',
    buyerSavedAddressHttp: '买家收货地址',
    buyerTakeoverTimelineHttp: '买家接管进度',
    merchantLifecycleHttp: '商家审核',
    merchantQualificationEncryption: '商家资质加密',
  } as Record<string, string>)[name] ?? name;
}

function publicationLabel(value: string) {
  return ({
    COORDINATED_SETTLEMENT_ADMIN_CHECKPOINT: '正式发布中',
    COORDINATED_MERCHANT_GOVERNANCE_CHECKPOINT: '正式发布中',
    COORDINATED_FULFILLMENT_CHECKPOINT: '正式发布中',
    COORDINATED_PAYMENT_CHECKPOINT: '正式发布中',
  } as Record<string, string>)[value] ?? humanizeSystemKey(value);
}

function statusLabel(value: string | undefined) {
  return value === 'CORE_API_READY' ? '运行正常' : value ?? '未知';
}

function humanStatusError(message: string) {
  if (/Core API is unreachable|gateway is unavailable|unavailable|unreachable/i.test(message)) return '后台服务暂时无法连接，请稍后重试。';
  if (/non-JSON|incompatible|artifact|version/i.test(message)) return '当前页面版本和后台版本不一致，请刷新页面或重新部署前端。';
  return humanizeSystemKey(message);
}

function errorLabel(value: string | undefined) {
  const text = String(value ?? '');
  return ({
    ExternalBlocked: '系统服务暂时异常',
    DecisionBlocked: '需要人工确认',
    ConfigurationRequired: '配置未完成',
    Forbidden: '没有权限',
    Unavailable: '未返回数据',
    RELEASE_AUTHORIZATION_INVALID: '发布授权和当前版本不匹配',
    COORDINATED_DEPLOYMENT_AUTHORIZATION: '等待正式发布授权',
    PAYMENT_CONFIGURATION_REQUIRED: '新支付配置未完成',
    AMAP_WEB_SERVICE_KEY: '地图服务待配置',
    SECRET_RESOLVER_URL: '密钥服务地址待配置',
    SECRET_RESOLVER_TOKEN: '密钥服务令牌待配置',
  } as Record<string, string>)[text] ?? (text ? humanizeSystemKey(text) : '操作失败');
}

function humanizeSystemKey(value: string) {
  const replaced = value
    .replace(/[_-]+/g, ' ')
    .replace(/\bAPI\b/g, '接口')
    .replace(/\bRPC\b/g, '链路')
    .replace(/\bURL\b/g, '地址')
    .replace(/\bTOKEN\b/g, '令牌')
    .replace(/\bREQUIRED\b/g, '待配置')
    .replace(/\bINVALID\b/g, '不匹配')
    .replace(/\bAUTHORIZATION\b/g, '授权')
    .replace(/\bCONFIGURATION\b/g, '配置')
    .replace(/\bPAYMENT\b/g, '支付')
    .replace(/\bRELEASE\b/g, '发布');
  return /[\u4e00-\u9fff]/.test(replaced) ? replaced : '系统状态未就绪';
}

function BlockedList({ title, values, loading }: { title: string; values: readonly string[] | undefined; loading: boolean }) {
  return (
    <article className="panel blocker-panel">
      <p className="section-kicker">安全检查</p><h2>{title}</h2>
      {loading ? <p className="muted-copy">正在读取系统状态...</p> : null}
      {!loading && values?.length === 0 ? <p className="healthy-copy"><CheckCircle2 aria-hidden="true" /> 系统当前没有限制项</p> : null}
      {values && values.length > 0 ? <ul>{values.map((value) => <li key={value}><Ban aria-hidden="true" /> {errorLabel(value)}</li>)}</ul> : null}
    </article>
  );
}
