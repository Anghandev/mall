const BSC_CHAIN_ID = 56;
const BSC_CHAIN_HEX = '0x38';
const SESSION_PREFIX = '24k.backstage.session.';

let currentSession = null;
let toastTimer = null;

export function getSession(role) {
  if (currentSession && (!role || currentSession.role === role)) return currentSession;
  if (!role) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(`${SESSION_PREFIX}${role}`) || 'null');
    if (!parsed?.token || !parsed?.address || Number(parsed.expiresAt) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function api(path, options = {}) {
  const session = options.session || currentSession;
  const headers = new Headers(options.headers || {});
  if (session?.token) headers.set('authorization', `Bearer ${session.token}`);
  if (options.body !== undefined && !(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined || options.body instanceof FormData || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body)
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) {
    const error = new Error(typeof data === 'object' && data?.error ? data.error : `HTTP_${response.status}`);
    error.status = response.status;
    error.data = data;
    if (response.status === 401 && session?.role) clearSession(session.role);
    throw error;
  }
  return data;
}

export async function signedAction(action, payload, submitPath, options = {}) {
  const session = requireSession();
  const intent = await api('/api/auth/action-intent', {
    method: 'POST',
    body: { action, payload },
    session
  });
  const signature = await personalSign(intent.secondaryMessage, session.address);
  const result = await api(submitPath, {
    method: options.method || 'POST',
    body: {
      ...(payload || {}),
      secondaryMessage: intent.secondaryMessage,
      secondarySignature: signature
    },
    session
  });
  if (result?.transactionIntent && options.sendTransaction !== false) {
    const transaction = await sendTransactionIntent(result.transactionIntent);
    return { ...result, transaction };
  }
  return result;
}

export async function sendTransactionIntent(intent) {
  const session = requireSession();
  const tx = intent?.transaction || intent?.tx || intent;
  if (!tx?.to || !tx?.data) throw new Error('TRANSACTION_INTENT_INVALID');
  await ensureBscNetwork();
  const transactionHash = await ethereumRequest('eth_sendTransaction', [{
    from: session.address,
    to: tx.to,
    data: tx.data,
    ...(tx.value ? { value: tx.value } : {})
  }]);
  return {
    transactionHash,
    explorerUrl: `https://bscscan.com/tx/${transactionHash}`,
    receipt: await waitForReceipt(transactionHash, intent?.confirmations || 1)
  };
}

export async function bootConsole({ role, render }) {
  if (role !== 'merchant' && role !== 'admin') throw new Error('INVALID_CONSOLE_ROLE');
  const root = document.querySelector('#console-root');
  if (!root) throw new Error('CONSOLE_ROOT_NOT_FOUND');

  const refresh = async () => {
    const session = getSession(role);
    if (!session) return renderLogin(root, role, render, refresh);
    currentSession = session;
    try {
      await api(`/api/${role}/dashboard`, { session });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        clearSession(role);
        return renderLogin(root, role, render, refresh, error.message);
      }
      return renderLogin(root, role, render, refresh, error.message, true);
    }
    renderShell(root, role, session, render, refresh);
  };

  window.ethereum?.on?.('accountsChanged', (accounts) => {
    const next = String(accounts?.[0] || '').toLowerCase();
    if (!next || next !== String(currentSession?.address || '').toLowerCase()) {
      clearSession(role);
      refresh();
    }
  });
  window.ethereum?.on?.('chainChanged', () => refresh());
  await refresh();
}

function renderLogin(root, role, render, refresh, errorMessage = '', retryOnly = false) {
  currentSession = null;
  const label = role === 'merchant' ? '商家工作台' : '平台运营后台';
  root.innerHTML = `
    <main class="auth-page">
      <section class="auth-brand" aria-label="24K Mall">
        <img src="/api/logo" alt="24K Mall" class="auth-logo" />
        <p>24K MALL · BSC</p>
        <h1>${label}</h1>
        <div class="auth-facts">
          <span>SIWE / EIP-4361</span><span>NPL ONLY</span><span>二次签名审计</span>
        </div>
      </section>
      <section class="auth-panel">
        <div class="eyebrow">AUTHORIZED ACCESS</div>
        <h2>使用已授权钱包登录</h2>
        <p>连接钱包后签署一次免 Gas 登录消息。平台不会索取助记词或私钥。</p>
        ${errorMessage ? `<div class="alert error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
        <button class="button primary auth-connect" type="button">${retryOnly ? '重新检查服务' : '连接钱包并签名'}</button>
        <a class="text-link" href="/preview">返回商城</a>
        <small>Chain ID ${BSC_CHAIN_ID} · 登录 nonce 单次有效 · JWT 到期自动退出</small>
      </section>
    </main>`;
  root.querySelector('.auth-connect')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = retryOnly ? '检查中...' : '等待钱包确认...';
    try {
      if (retryOnly) return await refresh();
      const session = await signIn(role);
      currentSession = session;
      persistSession(session);
      await refresh();
    } catch (error) {
      showToast(friendlyError(error), 'error');
      button.disabled = false;
      button.textContent = '连接钱包并签名';
    }
  });
}

function renderShell(root, role, session, render, refresh) {
  root.innerHTML = '<div id="console-app" class="console-app" aria-live="polite"></div>';
  const app = root.querySelector('#console-app');
  const context = {
    role,
    address: session.address,
    token: session.token,
    root: app,
    refresh,
    logout: () => {
      clearSession(role);
      refresh();
    }
  };
  Promise.resolve(render(context)).catch((error) => {
    app.innerHTML = `<section class="fatal-state"><h1>后台加载失败</h1><p>${escapeHtml(friendlyError(error))}</p><button class="button primary" data-retry>重新加载</button></section>`;
    app.querySelector('[data-retry]')?.addEventListener('click', refresh);
  });
}

async function signIn(role) {
  if (!window.ethereum) throw new Error('WALLET_EXTENSION_REQUIRED');
  await ensureBscNetwork();
  const accounts = await ethereumRequest('eth_requestAccounts');
  const address = String(accounts?.[0] || '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('WALLET_ADDRESS_INVALID');
  const nonce = await api('/api/auth/siwe/nonce', {
    method: 'POST',
    body: { address, role },
    session: null
  });
  const signature = await personalSign(nonce.message, address);
  const verified = await api('/api/auth/siwe/verify', {
    method: 'POST',
    body: { address, role, message: nonce.message, signature },
    session: null
  });
  return {
    role,
    address: verified.address,
    token: verified.token,
    expiresAt: Number(verified.expiresAt)
  };
}

async function ensureBscNetwork() {
  if (!window.ethereum) throw new Error('WALLET_EXTENSION_REQUIRED');
  const chainId = await ethereumRequest('eth_chainId');
  if (String(chainId).toLowerCase() === BSC_CHAIN_HEX) return;
  try {
    await ethereumRequest('wallet_switchEthereumChain', [{ chainId: BSC_CHAIN_HEX }]);
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await ethereumRequest('wallet_addEthereumChain', [{
      chainId: BSC_CHAIN_HEX,
      chainName: 'BNB Smart Chain',
      nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
      rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
      blockExplorerUrls: ['https://bscscan.com']
    }]);
  }
}

async function personalSign(message, address) {
  return ethereumRequest('personal_sign', [utf8ToHex(message), address]);
}

async function ethereumRequest(method, params = []) {
  if (!window.ethereum?.request) throw new Error('WALLET_EXTENSION_REQUIRED');
  return window.ethereum.request({ method, params });
}

async function waitForReceipt(transactionHash, confirmations) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180_000) {
    const receipt = await ethereumRequest('eth_getTransactionReceipt', [transactionHash]);
    if (receipt?.blockNumber) {
      if (receipt.status === '0x0') throw new Error('TRANSACTION_REVERTED');
      if (confirmations <= 1) return receipt;
      const head = Number.parseInt(await ethereumRequest('eth_blockNumber'), 16);
      const included = Number.parseInt(receipt.blockNumber, 16);
      if (head - included + 1 >= confirmations) return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error('TRANSACTION_CONFIRMATION_TIMEOUT');
}

function requireSession() {
  if (!currentSession?.token || Number(currentSession.expiresAt) <= Date.now()) {
    throw new Error('SESSION_EXPIRED');
  }
  return currentSession;
}

function persistSession(session) {
  localStorage.setItem(`${SESSION_PREFIX}${session.role}`, JSON.stringify(session));
}

function clearSession(role) {
  localStorage.removeItem(`${SESSION_PREFIX}${role}`);
  if (currentSession?.role === role) currentSession = null;
}

function utf8ToHex(value) {
  return `0x${Array.from(new TextEncoder().encode(String(value)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function downloadBlob(data, fileName, type = 'text/csv;charset=utf-8') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFileName(fileName);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function artifactBlob(artifact, expectedMimePrefix = '') {
  if (!artifact || typeof artifact !== 'object') throw new Error('FILE_ARTIFACT_MISSING');
  if (!safeFileName(artifact.fileName)) throw new Error('FILE_ARTIFACT_NAME_MISSING');
  if (String(artifact.encoding || '').toLowerCase() !== 'base64') throw new Error('FILE_ARTIFACT_ENCODING_UNSUPPORTED');
  const mimeType = String(artifact.mimeType || '').trim();
  if (!mimeType || (expectedMimePrefix && !mimeType.toLowerCase().startsWith(expectedMimePrefix.toLowerCase()))) {
    throw new Error('FILE_ARTIFACT_MIME_INVALID');
  }
  const dataUrlComma = typeof artifact.dataUrl === 'string' ? artifact.dataUrl.indexOf(',') : -1;
  const dataUrlContent = dataUrlComma >= 0 ? artifact.dataUrl.slice(dataUrlComma + 1) : '';
  const contentBase64 = String(artifact.contentBase64 || dataUrlContent || '').replace(/\s/g, '');
  if (!contentBase64) throw new Error('FILE_ARTIFACT_CONTENT_MISSING');
  let binary;
  try {
    binary = atob(contentBase64);
  } catch {
    throw new Error('FILE_ARTIFACT_BASE64_INVALID');
  }
  return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type: mimeType });
}

export function downloadArtifact(artifact) {
  const fileName = safeFileName(artifact?.fileName);
  if (!fileName) throw new Error('FILE_ARTIFACT_NAME_MISSING');
  downloadBlob(artifactBlob(artifact), fileName, artifact.mimeType);
  return fileName;
}

export async function printHtmlArtifact(artifact) {
  const source = await artifactBlob(artifact, 'text/html').text();
  const documentNode = new DOMParser().parseFromString(source, 'text/html');
  documentNode.querySelectorAll('script').forEach((node) => node.remove());
  const printBlob = new Blob([`<!doctype html>\n${documentNode.documentElement.outerHTML}`], { type: artifact.mimeType });
  const url = URL.createObjectURL(printBlob);
  const frame = document.createElement('iframe');
  frame.title = '打印文档';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:1px;height:1px;border:0;right:0;bottom:0;opacity:0;pointer-events:none';
  const cleanup = () => {
    frame.remove();
    URL.revokeObjectURL(url);
  };
  await new Promise((resolve, reject) => {
    frame.addEventListener('load', resolve, { once: true });
    frame.addEventListener('error', () => reject(new Error('PRINT_DOCUMENT_LOAD_FAILED')), { once: true });
    frame.src = url;
    document.body.appendChild(frame);
  });
  const printWindow = frame.contentWindow;
  if (!printWindow) {
    cleanup();
    throw new Error('PRINT_WINDOW_UNAVAILABLE');
  }
  printWindow.addEventListener('afterprint', cleanup, { once: true });
  printWindow.focus();
  printWindow.print();
  setTimeout(() => { if (frame.isConnected) cleanup(); }, 60_000);
  return safeFileName(artifact.fileName);
}

function safeFileName(value) {
  return String(value || '').split(/[\\/]/).pop().trim();
}

export function showToast(message, tone = 'success') {
  let toast = document.querySelector('#global-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'global-toast';
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.className = `toast ${tone}`;
  toast.textContent = String(message || '操作完成');
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

export function formatAmount(value, suffix = '') {
  const number = Number(value || 0);
  const digits = Math.abs(number) > 0 && Math.abs(number) < 0.01 ? 6 : 2;
  const formatted = Number.isFinite(number)
    ? number.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '0.00';
  return suffix ? `${formatted} ${suffix}` : formatted;
}

export function shortAddress(value) {
  const text = String(value || '');
  return text.length > 13 ? `${text.slice(0, 7)}...${text.slice(-5)}` : text;
}

function friendlyError(error) {
  const code = String(error?.message || error || 'UNKNOWN_ERROR');
  const messages = {
    WALLET_EXTENSION_REQUIRED: '未检测到支持 EVM 的钱包，请在 MetaMask 或 OKX Wallet 浏览器中打开。',
    MERCHANT_WALLET_NOT_WHITELISTED: '当前钱包不在已审核商家白名单中。',
    ADMIN_WALLET_NOT_ALLOWED: '当前钱包不是平台授权管理员。',
    ADMIN_WALLET_NOT_CONFIGURED: '平台尚未配置管理员钱包。',
    SESSION_EXPIRED: '登录已过期，请重新签名。',
    ACTION_NONCE_REPLAYED: '本次授权已使用，请重新发起操作。',
    TRANSACTION_REVERTED: '链上交易执行失败，资金未完成划转。',
    TRANSACTION_CONFIRMATION_TIMEOUT: '交易已广播但确认超时，请在 BscScan 核对。',
    WALLET_ACTION_REJECTED: '钱包已取消操作。'
  };
  if (Number(error?.code) === 4001) return '钱包已取消操作。';
  return messages[code] || code.replaceAll('_', ' ');
}
