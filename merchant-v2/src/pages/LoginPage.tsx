import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleHelp, LoaderCircle, ShieldCheck, WalletCards } from 'lucide-react';
import logo from '../assets/abu-24k-logo.png';
import { CoreUnavailable } from '../components/ui';
import { useCoreRuntime } from '../core-runtime';
import { walletProvider, type WalletKind } from '../wallet';

export function LoginPage() {
  const { authError, bootstrap, signIn, signingIn } = useCoreRuntime();
  const [selectedWallet, setSelectedWallet] = useState<WalletKind>('metamask');
  const metaMask = walletProvider('metamask');
  const okx = walletProvider('okx');
  const selectedProvider = walletProvider(selectedWallet);
  const canConnect = bootstrap.phase === 'ready' && Boolean(selectedProvider) && !signingIn;

  async function handleSignIn() {
    if (!selectedProvider) return;
    try {
      await signIn(selectedProvider);
    } catch {
      // The runtime exposes a sanitized, accessible error below the action.
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand" aria-labelledby="login-brand-title">
        <div className="login-brand-inner">
          <img alt="" src={logo} />
          <p className="eyebrow">24K商城 · 商家工作台</p>
          <h1 id="login-brand-title">一件商品，一条清晰的履约链路。</h1>
          <p>从提报、交付到签名结算申请，所有关键操作绑定商家钱包与可审计证据。</p>
          <ul>
            <li><Check aria-hidden="true" size={17} /> 使用商家钱包登录</li>
            <li><Check aria-hidden="true" size={17} /> 连接时不扣 Gas</li>
            <li><Check aria-hidden="true" size={17} /> 重要操作会再次让你确认</li>
          </ul>
        </div>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-box">
          <div className="login-heading">
            <span className="login-icon"><WalletCards aria-hidden="true" size={23} /></span>
            <div>
              <p className="eyebrow">00 / 钱包登录</p>
              <h2 id="login-title">连接授权商家钱包</h2>
            </div>
          </div>
          <p className="login-copy">这里不用账号密码。选择浏览器钱包，按钱包弹窗确认一次即可进入。</p>
          <CoreUnavailable />
          <div className="wallet-list" aria-label="支持的钱包">
            <button aria-pressed={selectedWallet === 'metamask'} className={selectedWallet === 'metamask' ? 'selected' : undefined} disabled={!metaMask || signingIn} onClick={() => setSelectedWallet('metamask')} type="button"><span className="wallet-mark">M</span><span><strong>MetaMask</strong><small>浏览器钱包</small></span><span>{metaMask ? '已检测' : '未安装'}</span></button>
            <button aria-pressed={selectedWallet === 'okx'} className={selectedWallet === 'okx' ? 'selected' : undefined} disabled={!okx || signingIn} onClick={() => setSelectedWallet('okx')} type="button"><span className="wallet-mark okx">O</span><span><strong>OKX Wallet</strong><small>浏览器钱包</small></span><span>{okx ? '已检测' : '未安装'}</span></button>
          </div>
          <button className="button primary wide" disabled={!canConnect} onClick={() => void handleSignIn()} type="button">
            {signingIn ? <><LoaderCircle aria-hidden="true" className="spin" size={16} /> 等待钱包签名</> : '已是商家，连接钱包'}
          </button>
          <Link className="button secondary wide apply-entry-link" to="/apply">我要入驻商家</Link>
          {authError ? <p className="form-error" role="alert">{authError}</p> : null}
          <div className="login-security">
            <ShieldCheck aria-hidden="true" size={17} />
            <span>系统会自动确认钱包、网络和商家权限；钱包不对或拒绝签名，都不会登录成功。</span>
          </div>
          <button className="support-link" disabled type="button">
            <CircleHelp aria-hidden="true" size={16} /> 如需帮助，请联系平台运营
          </button>
        </div>
      </section>
    </main>
  );
}
