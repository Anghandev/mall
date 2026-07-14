import { Check, CircleHelp, ShieldCheck, WalletCards } from 'lucide-react';
import logo from '../assets/abu-24k-logo.png';
import { CoreUnavailable } from '../components/ui';

export function LoginPage() {
  return (
    <main className="login-page">
      <section className="login-brand" aria-labelledby="login-brand-title">
        <div className="login-brand-inner">
          <img alt="" src={logo} />
          <p className="eyebrow">Abu 24K Merchant</p>
          <h1 id="login-brand-title">一件商品，一条清晰的履约链路。</h1>
          <p>从提报、交付到资产 Claim，所有关键操作绑定商家钱包与可审计证据。</p>
          <ul>
            <li><Check aria-hidden="true" size={17} /> BSC 主网身份域</li>
            <li><Check aria-hidden="true" size={17} /> EIP-4361 一次性签名</li>
            <li><Check aria-hidden="true" size={17} /> 敏感操作二次钱包签名</li>
          </ul>
        </div>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-box">
          <div className="login-heading">
            <span className="login-icon"><WalletCards aria-hidden="true" size={23} /></span>
            <div>
              <p className="eyebrow">00 / 统一登录网关</p>
              <h2 id="login-title">连接授权商家钱包</h2>
            </div>
          </div>
          <p className="login-copy">本工作台不提供账号密码登录。连接后将请求一次无 Gas 的身份签名。</p>
          <CoreUnavailable />
          <div className="wallet-list" aria-label="支持的钱包">
            <button disabled type="button"><span className="wallet-mark">M</span><span><strong>MetaMask</strong><small>浏览器钱包</small></span><span>不可用</span></button>
            <button disabled type="button"><span className="wallet-mark okx">O</span><span><strong>OKX Wallet</strong><small>浏览器钱包</small></span><span>不可用</span></button>
          </div>
          <button className="button primary wide" disabled type="button">连接钱包</button>
          <div className="login-security">
            <ShieldCheck aria-hidden="true" size={17} />
            <span>Nonce、时间戳、授权商家校验与会话角色均由 Core 验证。错误网络、拒签或未授权地址不会创建会话。</span>
          </div>
          <button className="support-link" disabled type="button">
            <CircleHelp aria-hidden="true" size={16} /> 平台支持渠道未配置
          </button>
        </div>
      </section>
    </main>
  );
}
