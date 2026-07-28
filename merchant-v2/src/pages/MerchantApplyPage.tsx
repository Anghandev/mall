import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleHelp, LoaderCircle, Store, WalletCards } from 'lucide-react';
import logo from '../assets/abu-24k-logo.png';
import { CoreUnavailable } from '../components/ui';
import { readableError, useCoreRuntime } from '../core-runtime';
import { walletProvider, type WalletKind } from '../wallet';

interface ApplyFormState {
  shopName: string;
  legalName: string;
  legalId: string;
  contactPhone: string;
}

const emptyForm: ApplyFormState = {
  shopName: '',
  legalName: '',
  legalId: '',
  contactPhone: '',
};

export function MerchantApplyPage() {
  const { bootstrap, submitMerchantApplication } = useCoreRuntime();
  const [selectedWallet, setSelectedWallet] = useState<WalletKind>('metamask');
  const [form, setForm] = useState(emptyForm);
  const [idempotencyKey, setIdempotencyKey] = useState(createApplicationKey);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ merchantId: string; shopName: string | null } | null>(null);
  const metaMask = walletProvider('metamask');
  const okx = walletProvider('okx');
  const selectedProvider = walletProvider(selectedWallet);
  const canSubmit = bootstrap.phase === 'ready' && Boolean(selectedProvider) && !submitting;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedProvider) {
      setError('没有检测到这个钱包，请先安装或换一个钱包。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitMerchantApplication(selectedProvider, { ...form, idempotencyKey });
      setSuccess({ merchantId: result.merchantId, shopName: result.shopName });
      setIdempotencyKey(createApplicationKey());
    } catch (cause) {
      setError(applicationError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page apply-page">
      <section className="login-brand apply-brand" aria-labelledby="apply-brand-title">
        <div className="login-brand-inner">
          <img alt="" src={logo} />
          <p className="eyebrow">24K商城 · 商家入驻</p>
          <h1 id="apply-brand-title">填资料，签一次，等审核。</h1>
          <p>不用进平台后台。审核通过后，就用这个钱包登录商家工作台。</p>
          <ul>
            <li><Check aria-hidden="true" size={17} /> 钱包只确认本人，不扣钱</li>
            <li><Check aria-hidden="true" size={17} /> 结算钱包自动绑定当前钱包</li>
            <li><Check aria-hidden="true" size={17} /> 审核通过后再管理门店和商品</li>
          </ul>
        </div>
      </section>
      <section className="login-panel apply-panel" aria-labelledby="apply-title">
        <div className="login-box apply-box">
          <div className="login-heading">
            <span className="login-icon"><Store aria-hidden="true" size={23} /></span>
            <div>
              <p className="eyebrow">商家申请</p>
              <h2 id="apply-title">我要入驻商家</h2>
            </div>
          </div>
          <p className="login-copy">填写真实资料，然后选择钱包签名提交。审核通过前不会开通经营权限。</p>
          <CoreUnavailable />

          {success ? (
            <div className="apply-success" role="status">
              <Check aria-hidden="true" />
              <div>
                <strong>申请已提交</strong>
                <p>平台审核通过后，用刚才签名的钱包登录商家后台。</p>
                <small>{success.shopName ?? '你的店铺'} 已进入待审核列表。</small>
              </div>
              <Link className="button primary wide" to="/">返回登录</Link>
            </div>
          ) : (
            <form className="apply-form" onSubmit={submit}>
              <div className="apply-fields">
                <label>店铺名称<input value={form.shopName} onChange={(event) => setForm({ ...form, shopName: event.target.value })} maxLength={80} required /></label>
                <label>主体名称<input value={form.legalName} onChange={(event) => setForm({ ...form, legalName: event.target.value })} minLength={2} maxLength={80} required /></label>
                <label>证件编号<input value={form.legalId} onChange={(event) => setForm({ ...form, legalId: event.target.value })} minLength={6} maxLength={32} required /></label>
                <label>联系电话<input value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} minLength={6} maxLength={32} required /></label>
              </div>

              <div className="wallet-list" aria-label="选择签名钱包">
                <button aria-pressed={selectedWallet === 'metamask'} className={selectedWallet === 'metamask' ? 'selected' : undefined} disabled={!metaMask || submitting} onClick={() => setSelectedWallet('metamask')} type="button"><span className="wallet-mark">M</span><span><strong>MetaMask</strong><small>浏览器钱包</small></span><span>{metaMask ? '已检测' : '未安装'}</span></button>
                <button aria-pressed={selectedWallet === 'okx'} className={selectedWallet === 'okx' ? 'selected' : undefined} disabled={!okx || submitting} onClick={() => setSelectedWallet('okx')} type="button"><span className="wallet-mark okx">O</span><span><strong>OKX Wallet</strong><small>浏览器钱包</small></span><span>{okx ? '已检测' : '未安装'}</span></button>
              </div>

              <button className="button primary wide" disabled={!canSubmit} type="submit">
                {submitting ? <><LoaderCircle aria-hidden="true" className="spin" size={16} /> 等待钱包确认</> : <><WalletCards aria-hidden="true" size={16} /> 连接钱包并提交申请</>}
              </button>
              {error ? <p className="form-error" role="alert">{error}</p> : null}
              <div className="login-security">
                <CircleHelp aria-hidden="true" size={17} />
                <span>营业执照第一版可由平台线下确认；需要上传时，平台运营会在审核后台补齐。</span>
              </div>
              <Link className="support-link apply-back-link" to="/">已经是商家？返回登录</Link>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

function createApplicationKey() {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `merchant-public-apply-${Date.now()}-${random}`;
}

function applicationError(cause: unknown) {
  const message = readableError(cause);
  if (/already merchant-bound|already submitted|already has a pending/i.test(message)) {
    return '这个钱包已经提交过申请，或已经是商家。请等待审核，或返回登录。';
  }
  if (/Wallet is not authorized|没有商家工作台权限/i.test(message)) {
    return '申请已提交前不能登录后台。请先完成入驻申请，等平台审核。';
  }
  if (/idempotency/i.test(message)) return '系统没有确认这次提交，请刷新页面后再试一次。';
  return message;
}
