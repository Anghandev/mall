import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download,
  FileClock,
  ImagePlus,
  KeyRound,
  Printer,
  RefreshCw,
  ShieldCheck,
  Store,
  Trash2,
  WalletCards,
} from 'lucide-react';
import {
  auditStreamNames,
  type AuditStreamName,
  type MediaReadAccessProjection,
  type MerchantAuditList,
  type MerchantProfile,
} from '@abu24k/core-artifacts';
import { EmptyState, FieldHelp, LoadingRows, PageHeader } from '../components/ui';
import {
  CoreApiError,
  putMediaFile,
  sha256File,
  type MerchantAuditExportRequest,
  type MerchantAuditListOptions,
} from '../core-api';
import { readableError, useCoreRuntime } from '../core-runtime';

type ProfileState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; value: MerchantProfile };

type AuditState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; value: MerchantAuditList };

interface AuditFilters {
  from: string;
  to: string;
  streamName: '' | AuditStreamName;
  eventType: string;
  resourceType: string;
}

interface Feedback {
  tone: 'success' | 'error' | 'info';
  message: string;
}

const emptyFilters: AuditFilters = {
  from: '',
  to: '',
  streamName: '',
  eventType: '',
  resourceType: '',
};

const streamLabels: Record<AuditStreamName, string> = {
  financial: '资金',
  governance: '治理',
  authentication: '认证',
  operational: '运营',
  backup: '备份',
};

export function SettingsPage() {
  const { api, session } = useCoreRuntime();
  const [profile, setProfile] = useState<ProfileState>({ phase: 'loading' });
  const [shopName, setShopName] = useState('');
  const [logoAssetId, setLogoAssetId] = useState<string | null>(null);
  const [logoAccess, setLogoAccess] = useState<MediaReadAccessProjection>();
  const [logoError, setLogoError] = useState<string>();
  const [profileBusy, setProfileBusy] = useState<'save' | 'logo'>();
  const [profileFeedback, setProfileFeedback] = useState<Feedback>();
  const profileCommand = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const logoCommands = useRef(new Map<string, string>());

  const [filters, setFilters] = useState<AuditFilters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<AuditFilters>(emptyFilters);
  const [audit, setAudit] = useState<AuditState>({ phase: 'loading' });
  const [auditBusy, setAuditBusy] = useState<'page' | 'export'>();
  const [auditFeedback, setAuditFeedback] = useState<Feedback>();
  const exportCommand = useRef<{ fingerprint: string; key: string } | undefined>(undefined);

  const readLogo = useCallback(async (value: MerchantProfile) => {
    setLogoAccess(undefined);
    setLogoError(undefined);
    if (!session || !value.logoAssetId) return;
    try {
      setLogoAccess(await api.getMediaReadAccess(value.logoAssetId, session.token, {
        resourceType: 'MERCHANT',
        resourceId: value.merchantId,
        purpose: 'MERCHANT_LOGO',
      }));
    } catch (error) {
      setLogoError(readableError(error));
    }
  }, [api, session]);

  const loadProfile = useCallback(async () => {
    if (!session) {
      setProfile({ phase: 'error', message: '请先使用授权商家钱包登录。' });
      return;
    }
    setProfile({ phase: 'loading' });
    setProfileFeedback(undefined);
    try {
      const value = await api.getMerchantProfile(session.token);
      requireMerchantScope(value.merchantId, session.merchantId, '店铺资料');
      setProfile({ phase: 'ready', value });
      setShopName(value.shopName ?? '');
      setLogoAssetId(value.logoAssetId);
      profileCommand.current = undefined;
      await readLogo(value);
    } catch (error) {
      setProfile({ phase: 'error', message: readableError(error) });
    }
  }, [api, readLogo, session]);

  const loadAudit = useCallback(async (
    nextFilters: AuditFilters,
    cursor?: NonNullable<MerchantAuditList['nextCursor']>,
  ) => {
    if (!session) {
      setAudit({ phase: 'error', message: '请先使用授权商家钱包登录。' });
      return;
    }
    if (!cursor) setAudit({ phase: 'loading' });
    else setAuditBusy('page');
    setAuditFeedback(undefined);
    try {
      const options = auditListOptions(nextFilters, cursor);
      const value = await api.listMerchantAuditEntries(session.token, options);
      requireMerchantScope(value.chainProof.merchantId, session.merchantId, '审计日志');
      setAudit((current) => ({
        phase: 'ready',
        value: cursor && current.phase === 'ready'
          ? { ...value, entries: [...current.value.entries, ...value.entries] }
          : value,
      }));
      setAppliedFilters(nextFilters);
    } catch (error) {
      if (!cursor) setAudit({ phase: 'error', message: readableError(error) });
      else setAuditFeedback({ tone: 'error', message: readableError(error) });
    } finally {
      setAuditBusy(undefined);
    }
  }, [api, session]);

  useEffect(() => {
    void loadProfile();
    void loadAudit(emptyFilters);
  }, [loadAudit, loadProfile]);

  async function saveProfile() {
    if (!session || profile.phase !== 'ready' || profileBusy) return;
    const normalizedName = shopName.trim();
    if (normalizedName.length < 1 || normalizedName.length > 100) {
      setProfileFeedback({ tone: 'error', message: '店铺名称必须为 1-100 个字符。' });
      return;
    }
    const payload = {
      shopName: normalizedName,
      logoAssetId,
      expectedVersion: profile.value.version,
    };
    const fingerprint = JSON.stringify(payload);
    if (profileCommand.current?.fingerprint !== fingerprint) {
      profileCommand.current = {
        fingerprint,
        key: `merchant-profile-${crypto.randomUUID()}`,
      };
    }
    setProfileBusy('save');
    setProfileFeedback(undefined);
    try {
      const value = await api.updateMerchantProfile({
        ...payload,
        idempotencyKey: profileCommand.current.key,
      }, session.token);
      if (
        value.merchantId !== session.merchantId
        || value.merchantId !== profile.value.merchantId
        || value.settlementWallet.toLowerCase() !== profile.value.settlementWallet.toLowerCase()
        || value.shopName !== normalizedName
        || value.logoAssetId?.toLowerCase() !== logoAssetId?.toLowerCase()
        || value.version <= profile.value.version
      ) throw new CoreApiError('InvalidResponse', '保存结果与当前商家资料快照不一致。');
      profileCommand.current = undefined;
      setProfile({ phase: 'ready', value });
      setShopName(value.shopName ?? '');
      setLogoAssetId(value.logoAssetId);
      setProfileFeedback({ tone: 'success', message: `店铺资料已保存为版本 ${value.version}。` });
      await readLogo(value);
      await loadAudit(appliedFilters);
    } catch (error) {
      setProfileFeedback({
        tone: 'error',
        message: error instanceof CoreApiError && error.status === 409
          ? '资料已被其他会话更新。请刷新后检查新版本，再重新保存。'
          : readableError(error),
      });
    } finally {
      setProfileBusy(undefined);
    }
  }

  async function uploadLogo(file: File) {
    if (!session || profile.phase !== 'ready' || profileBusy) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) {
      setProfileFeedback({ tone: 'error', message: 'Logo 仅支持 JPG、PNG 或 WebP，文件不超过 10 MB。' });
      return;
    }
    setProfileBusy('logo');
    setProfileFeedback(undefined);
    try {
      const contentSha256 = await sha256File(file);
      const fingerprint = JSON.stringify({
        merchantId: profile.value.merchantId,
        contentSha256,
        contentType: file.type,
        sizeBytes: file.size,
      });
      const idempotencyKey = logoCommands.current.get(fingerprint)
        ?? `merchant-logo-${crypto.randomUUID()}`;
      logoCommands.current.set(fingerprint, idempotencyKey);
      const intent = await api.createMediaUploadIntent({
        purpose: 'MERCHANT_LOGO',
        resourceType: 'MERCHANT',
        resourceId: profile.value.merchantId,
        contentType: file.type as 'image/jpeg' | 'image/png' | 'image/webp',
        sizeBytes: file.size,
        contentSha256,
        idempotencyKey,
      }, session.token, session.walletAddress);
      await putMediaFile(intent, file);
      const asset = await api.completeMediaUpload(intent, session.token);
      const access = await api.getMediaReadAccess(asset.assetId, session.token, {
        resourceType: 'MERCHANT',
        resourceId: profile.value.merchantId,
        purpose: 'MERCHANT_LOGO',
      });
      logoCommands.current.delete(fingerprint);
      setLogoAssetId(asset.assetId);
      setLogoAccess(access);
      setLogoError(undefined);
      setProfileFeedback({ tone: 'info', message: 'Logo 已完成存储封存与归属校验，请保存资料以绑定新资产。' });
    } catch (error) {
      setProfileFeedback({ tone: 'error', message: readableError(error) });
    } finally {
      setProfileBusy(undefined);
    }
  }

  async function exportAudit() {
    if (!session || auditBusy) return;
    if (
      profile.phase !== 'ready'
      || audit.phase !== 'ready'
      || profile.value.merchantId !== session.merchantId
      || audit.value.chainProof.merchantId !== session.merchantId
      || profile.value.merchantId !== audit.value.chainProof.merchantId
    ) {
      setAuditFeedback({ tone: 'error', message: '当前商家范围未通过校验，不能导出。' });
      return;
    }
    let input: Omit<MerchantAuditExportRequest, 'idempotencyKey'>;
    try {
      input = auditExportInput(filters);
    } catch (error) {
      setAuditFeedback({ tone: 'error', message: readableError(error) });
      return;
    }
    const fingerprint = JSON.stringify(input);
    if (exportCommand.current?.fingerprint !== fingerprint) {
      exportCommand.current = {
        fingerprint,
        key: `merchant-audit-export-${crypto.randomUUID()}`,
      };
    }
    setAuditBusy('export');
    setAuditFeedback(undefined);
    try {
      const result = await api.exportMerchantAuditEntries({
        ...input,
        idempotencyKey: exportCommand.current.key,
      }, session.token);
      requireMerchantScope(result.merchantId, session.merchantId, '审计导出');
      exportCommand.current = undefined;
      let feedback: Feedback;
      if (result.entryCount === 0) {
        feedback = { tone: 'info', message: '该时间范围没有可导出的商家范围审计记录。' };
      } else {
        downloadCsv(result.filename, result.contentType, result.csv);
        feedback = { tone: 'success', message: `已下载 ${result.entryCount} 条商家范围记录。` };
      }
      await loadAudit(appliedFilters);
      setAuditFeedback(feedback);
    } catch (error) {
      setAuditFeedback({ tone: 'error', message: readableError(error) });
    } finally {
      setAuditBusy(undefined);
    }
  }

  const sessionMerchantId = session?.merchantId;
  const auditScopeMismatch = Boolean(sessionMerchantId)
    && profile.phase === 'ready'
    && audit.phase === 'ready'
    && (
      profile.value.merchantId !== sessionMerchantId
      || audit.value.chainProof.merchantId !== sessionMerchantId
      || profile.value.merchantId !== audit.value.chainProof.merchantId
    );

  return (
    <div className="page-stack">
      <PageHeader description="维护店铺资料，查看只读结算身份与商家范围审计。" eyebrow="06 / 店铺与安全" title="系统配置" />

      <div className="settings-grid">
        <form className="section-block form-section" onSubmit={(event) => { event.preventDefault(); void saveProfile(); }} aria-labelledby="profile-title">
          <div className="section-heading">
            <div><p className="eyebrow">Profile</p><h2 id="profile-title">店铺基本资料</h2></div>
            <button className="icon-button" disabled={profile.phase === 'loading' || Boolean(profileBusy)} onClick={() => void loadProfile()} title="刷新店铺资料" type="button">
              <RefreshCw aria-hidden="true" size={18} /><span className="sr-only">刷新店铺资料</span>
            </button>
          </div>
          {profile.phase === 'loading' ? <LoadingRows count={3} /> : null}
          {profile.phase === 'error' ? <EmptyState blocked description={profile.message} title="店铺资料加载失败" /> : null}
          {profile.phase === 'ready' ? (
            <>
              <div className="field">
                <label htmlFor="shop-name">店铺名称</label>
                <input disabled={Boolean(profileBusy)} id="shop-name" maxLength={100} onChange={(event) => { setShopName(event.target.value); setProfileFeedback(undefined); }} required type="text" value={shopName} />
                <FieldHelp>{shopName.length} / 100，保存时使用当前资料版本 {profile.value.version}。</FieldHelp>
              </div>
              <fieldset className="field">
                <legend>品牌 Logo</legend>
                <div className="profile-logo-row">
                  <div className="profile-logo-preview">
                    {logoAccess ? <img alt="当前店铺 Logo" src={logoAccess.readUrl} /> : <Store aria-hidden="true" size={28} />}
                  </div>
                  <div className="profile-logo-actions">
                    <label className={`button secondary file-button${profileBusy ? ' disabled' : ''}`}>
                      <ImagePlus aria-hidden="true" size={16} /> {profileBusy === 'logo' ? '上传中…' : '上传 Logo'}
                      <input
                        accept="image/jpeg,image/png,image/webp"
                        disabled={Boolean(profileBusy)}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          if (file) void uploadLogo(file);
                        }}
                        type="file"
                      />
                    </label>
                    <button className="button quiet" disabled={!logoAssetId || Boolean(profileBusy)} onClick={() => { setLogoAssetId(null); setLogoAccess(undefined); setLogoError(undefined); setProfileFeedback({ tone: 'info', message: '保存资料后将解除当前 Logo 绑定。' }); }} type="button">
                      <Trash2 aria-hidden="true" size={16} /> 解除绑定
                    </button>
                  </div>
                </div>
                <FieldHelp>Logo 会经过系统上传、存储封存和钱包归属校验。</FieldHelp>
                {logoAssetId ? <details className="technical-details compact"><summary>Logo 核验信息</summary><code className="profile-asset-id" title={logoAssetId}>{shortHash(logoAssetId)}</code></details> : null}
                {logoError ? <p className="form-error" role="alert">Logo 读取失败：{logoError}</p> : null}
              </fieldset>
              {profileFeedback ? <p className={`command-notice ${profileFeedback.tone}`} role={profileFeedback.tone === 'error' ? 'alert' : 'status'}>{profileFeedback.message}</p> : null}
              <button className="button primary" disabled={Boolean(profileBusy) || shopName.trim().length < 1} type="submit">{profileBusy === 'save' ? '保存中…' : '保存资料'}</button>
            </>
          ) : null}
        </form>

        <section className="section-block wallet-panel" aria-labelledby="wallet-title">
          <div className="section-heading"><div><p className="eyebrow">结算身份</p><h2 id="wallet-title">绑定结算钱包</h2></div><WalletCards aria-hidden="true" size={19} /></div>
          {profile.phase === 'loading' ? <LoadingRows count={2} /> : null}
          {profile.phase === 'error' ? <EmptyState blocked description={profile.message} title="结算身份加载失败" /> : null}
          {profile.phase === 'ready' ? (
            <>
              <div className="wallet-address"><span>常驻结算钱包</span><strong title={profile.value.settlementWallet}>{shortAddress(profile.value.settlementWallet)}</strong><small title={profile.value.merchantId}>商家编号：{shortHash(profile.value.merchantId)}</small></div>
              <div className="governance-note"><KeyRound aria-hidden="true" size={18} /><div><strong>普通编辑不可更换</strong><p>该地址由系统锁定展示，普通资料编辑不能修改。钱包变更必须走治理迁移。</p></div></div>
              <dl className="profile-meta"><div><dt>资料版本</dt><dd>{profile.value.version}</dd></div><div><dt>更新时间</dt><dd>{formatDate(profile.value.updatedAt)}</dd></div></dl>
            </>
          ) : null}
        </section>
      </div>

      <section className="section-block audit-section" aria-labelledby="audit-title">
        <div className="section-heading">
          <div><p className="eyebrow">安全日志</p><h2 id="audit-title">操作日志</h2></div>
          <div className="audit-tools">
            <button className="button quiet" disabled={audit.phase === 'loading' || Boolean(auditBusy)} onClick={() => void loadAudit(appliedFilters)} type="button"><RefreshCw aria-hidden="true" size={16} /> 刷新</button>
            <button className="button secondary" disabled={Boolean(auditBusy) || !filters.from || !filters.to || profile.phase !== 'ready' || audit.phase !== 'ready' || auditScopeMismatch} onClick={() => void exportAudit()} type="button"><Download aria-hidden="true" size={16} /> {auditBusy === 'export' ? '导出中…' : '导出 CSV'}</button>
          </div>
        </div>

        <form className="audit-filter-bar" onSubmit={(event) => { event.preventDefault(); void loadAudit(filters); }}>
          <label><span>起始时间</span><input onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} type="datetime-local" value={filters.from} /></label>
          <label><span>结束时间</span><input onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} type="datetime-local" value={filters.to} /></label>
          <label><span>日志流</span><select onChange={(event) => setFilters((current) => ({ ...current, streamName: event.target.value as AuditFilters['streamName'] }))} value={filters.streamName}><option value="">全部</option>{auditStreamNames.map((stream) => <option key={stream} value={stream}>{streamLabels[stream]}</option>)}</select></label>
          <label><span>操作类型</span><input maxLength={128} onChange={(event) => setFilters((current) => ({ ...current, eventType: event.target.value }))} placeholder="精确操作名" value={filters.eventType} /></label>
          <label><span>影响模块</span><input maxLength={128} onChange={(event) => setFilters((current) => ({ ...current, resourceType: event.target.value }))} placeholder="精确模块名" value={filters.resourceType} /></label>
          <div className="filter-actions"><button className="button primary" disabled={Boolean(auditBusy)} type="submit">应用筛选</button><button className="button quiet" disabled={Boolean(auditBusy)} onClick={() => { setFilters(emptyFilters); void loadAudit(emptyFilters); }} type="button">重置</button></div>
        </form>

        <div className="audit-scope-notice" role="status">
          <ShieldCheck aria-hidden="true" size={17} />
          <div><strong>商家范围说明</strong><span>较早的历史日志可能不完整；当前数量只代表本商家页面已读取的记录。</span></div>
        </div>
        <div className="external-block-note" role="status"><Printer aria-hidden="true" size={17} /><span>本页只下载 CSV，不会发送打印任务；实体打印机后续单独接入。</span></div>
        {auditFeedback ? <p className={`command-notice audit-feedback ${auditFeedback.tone}`} role={auditFeedback.tone === 'error' ? 'alert' : 'status'}>{auditFeedback.message}</p> : null}

        {audit.phase === 'loading' ? <LoadingRows count={5} /> : null}
        {audit.phase === 'error' ? <EmptyState blocked description={audit.message} title="审计日志加载失败" /> : null}
        {auditScopeMismatch ? <EmptyState blocked description="系统返回的审计商家编号与当前资料不一致，已停止展示。" title="商家范围不匹配" /> : null}
        {audit.phase === 'ready' && !auditScopeMismatch ? (
          <>
            <div className="audit-summary"><span>当前已加载 {audit.value.entries.length} 条</span><span>系统记录数：{audit.value.chainProof.entries}</span><span title={audit.value.chainProof.merchantId}>范围：{shortHash(audit.value.chainProof.merchantId)}</span></div>
            <div className="table-wrap audit-table-wrap">
              <table>
                <thead><tr><th scope="col">操作时间</th><th scope="col">操作类型</th><th scope="col">影响模块</th><th scope="col">操作详情</th><th scope="col">签名凭证</th><th scope="col">钱包记录</th></tr></thead>
                <tbody>
                  {audit.value.entries.length === 0 ? (
                    <tr><td colSpan={6}><EmptyState description="当前商家范围和筛选条件下没有记录。" title="暂无审计日志" /></td></tr>
                  ) : audit.value.entries.map((entry) => (
                    <tr key={entry.entryId}>
                      <td className="audit-time">{formatDate(entry.operationTime)}</td>
                      <td><strong>{entry.operationType}</strong></td>
                      <td>{entry.module}</td>
                      <td className="audit-detail"><span>{entry.detail}</span><small title={entry.entryHash}>日志编号 {shortHash(entry.entryHash)}</small></td>
                      <td><HashValue value={entry.signatureHash} /></td>
                      <td>{entry.chainTxHash ? <details className="technical-details compact"><summary>客服核验编号</summary><a className="hash-link" href={`https://bscscan.com/tx/${entry.chainTxHash}`} rel="noreferrer" target="_blank">{shortHash(entry.chainTxHash)}</a></details> : <span className="muted-value">无</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {audit.value.nextCursor ? <div className="audit-pagination"><button className="button quiet" disabled={Boolean(auditBusy)} onClick={() => void loadAudit(appliedFilters, audit.value.nextCursor!)} type="button"><FileClock aria-hidden="true" size={16} /> {auditBusy === 'page' ? '加载中…' : '加载更早记录'}</button></div> : null}
          </>
        ) : null}
      </section>
    </div>
  );
}

function auditListOptions(filters: AuditFilters, cursor?: NonNullable<MerchantAuditList['nextCursor']>): MerchantAuditListOptions {
  const range = optionalRange(filters);
  return {
    ...range,
    ...(filters.streamName ? { streamName: filters.streamName } : {}),
    ...(filters.eventType.trim() ? { eventType: filters.eventType.trim() } : {}),
    ...(filters.resourceType.trim() ? { resourceType: filters.resourceType.trim() } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  };
}

function requireMerchantScope(actualMerchantId: string, sessionMerchantId: string, label: string) {
  if (actualMerchantId !== sessionMerchantId) {
    throw new CoreApiError('InvalidResponse', `${label}与当前商家会话不一致。`);
  }
}

function auditExportInput(filters: AuditFilters): Omit<MerchantAuditExportRequest, 'idempotencyKey'> {
  if (!filters.from || !filters.to) throw new Error('导出必须选择起始和结束时间。');
  const range = optionalRange(filters);
  if (!range.from || !range.to) throw new Error('导出时间范围不完整。');
  if (Date.parse(range.to) - Date.parse(range.from) > 31 * 24 * 60 * 60 * 1_000) {
    throw new Error('导出时间范围不能超过 31 天。');
  }
  return {
    from: range.from,
    to: range.to,
    ...(filters.streamName ? { streamName: filters.streamName } : {}),
    ...(filters.eventType.trim() ? { eventType: filters.eventType.trim() } : {}),
    ...(filters.resourceType.trim() ? { resourceType: filters.resourceType.trim() } : {}),
  };
}

function optionalRange(filters: AuditFilters) {
  const from = filters.from ? localDateTimeToIso(filters.from, '起始时间') : undefined;
  const to = filters.to ? localDateTimeToIso(filters.to, '结束时间') : undefined;
  if (from && to && Date.parse(from) > Date.parse(to)) throw new Error('起始时间不能晚于结束时间。');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function localDateTimeToIso(value: string, label: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}无效。`);
  return parsed.toISOString();
}

function downloadCsv(filename: string, contentType: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: contentType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function HashValue({ value }: { value: string | null }) {
  return value ? <code className="hash-value" title={value}>{shortHash(value)}</code> : <span className="muted-value">无</span>;
}

function shortHash(value: string) {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}
