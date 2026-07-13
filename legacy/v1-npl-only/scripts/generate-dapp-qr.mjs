#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readEnvFile } from './microtest/env-utils.mjs';

const env = { ...readEnvFile('.env'), ...process.env };
const targetUrl = chooseTargetUrl(process.argv[2], env);
const outDir = 'test-artifacts';
const svgPath = path.join(outDir, 'dapp-launch-qr.svg');
const pngPath = path.join(outDir, 'dapp-launch-qr.png');
const jsonPath = path.join(outDir, 'dapp-launch-qr.json');
const htmlPath = path.join(outDir, 'dapp-launch-qr.html');

fs.mkdirSync(outDir, { recursive: true });
const qrcode = await loadQrcode();
const svg = await qrcode.toString(targetUrl, {
  type: 'svg',
  width: 360,
  margin: 2,
  color: {
    dark: '#080704',
    light: '#fff7e6'
  }
});
await qrcode.toFile(pngPath, targetUrl, {
  type: 'png',
  width: 720,
  margin: 2,
  color: {
    dark: '#080704',
    light: '#fff7e6'
  }
});
fs.writeFileSync(svgPath, svg);
fs.writeFileSync(htmlPath, renderHtml(targetUrl, svg));
fs.writeFileSync(jsonPath, `${JSON.stringify({
  kind: '24k-dapp-launch-qr',
  targetUrl,
  svgPath,
  pngPath,
  htmlPath,
  externalPng: qrPngUrl(targetUrl),
  generatedAt: new Date().toISOString(),
  privateKeyPrinted: false,
  note: targetUrl.includes('127.0.0.1') || targetUrl.includes('localhost')
    ? 'localhost/127.0.0.1 只能本机打开；手机扫码请设置 DAPP_QR_URL 为 HTTPS 域名、内网穿透 URL，或同局域网 IP。'
    : '手机钱包/DApp 浏览器扫码打开此 URL。'
}, null, 2)}\n`);

console.log(`DApp QR target: ${targetUrl}`);
console.log(`wrote ${svgPath}`);
console.log(`wrote ${pngPath}`);
console.log(`wrote ${htmlPath}`);
console.log(`wrote ${jsonPath}`);

function chooseTargetUrl(argumentUrl, env) {
  const raw = argumentUrl || env.DAPP_QR_URL || env.DAPP_ENTRY_URL || env.DAPP_BASE_URL || env.FRONTEND_URL || 'http://localhost:8081';
  const url = normalizeUrl(raw);
  if (!isLoopback(url.hostname)) return url.toString();

  const lan = lanAddresses()[0];
  if (!lan) return url.toString();
  url.hostname = lan;
  return url.toString();
}

function normalizeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return new URL(`http://${value}`);
  }
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('198.18.')) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

async function loadQrcode() {
  const require = createRequire(import.meta.url);
  try {
    return require('qrcode');
  } catch {}

  const pnpmDir = path.resolve('node_modules/.pnpm');
  if (fs.existsSync(pnpmDir)) {
    const match = fs.readdirSync(pnpmDir).find((name) => /^qrcode@/.test(name));
    if (match) {
      const entry = path.join(pnpmDir, match, 'node_modules/qrcode/lib/index.js');
      if (fs.existsSync(entry)) return (await import(pathToFileURL(entry))).default;
    }
  }
  throw new Error('Cannot load qrcode. Run pnpm install, or set DAPP_QR_URL and use /api/dapp/launch-kit externalPng as fallback.');
}

function qrPngUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=360x360&format=png&data=${encodeURIComponent(value)}`;
}

function renderHtml(targetUrl, svg) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>24K DApp QR</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080704;color:#fff7e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(520px,92vw);padding:28px;border:1px solid rgba(216,162,58,.4);border-radius:28px;background:linear-gradient(180deg,#1a1308,#080704);box-shadow:0 30px 80px rgba(0,0,0,.45)}.qr{display:grid;place-items:center;padding:18px;border-radius:22px;background:#fff7e6}.qr svg{width:320px;height:320px}h1{margin:0 0 10px;font-size:24px}.url{word-break:break-all;color:#f6cf82;line-height:1.5}.hint{color:#c9b99a;line-height:1.6}</style>
</head>
<body><main class="card"><h1>24K DApp 扫码入口</h1><p class="hint">用手机钱包 / DApp 浏览器扫码打开。</p><div class="qr">${svg}</div><p class="url">${escapeHtml(targetUrl)}</p><p class="hint">如果手机打不开：电脑和手机不在同一网络，或电脑 VPN/代理挡住了局域网；请改用 HTTPS 域名/内网穿透 URL 后重跑 <code>DAPP_QR_URL=https://... pnpm dapp:qr</code>。</p></main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
