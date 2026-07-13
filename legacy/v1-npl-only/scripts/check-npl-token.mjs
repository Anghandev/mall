#!/usr/bin/env node
import { Contract, Interface, JsonRpcProvider } from 'ethers';
import { readEnvFile, targetChain } from './microtest/env-utils.mjs';

const FIXED_NPL = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const DEAD = '0x000000000000000000000000000000000000dead';
const strict = process.argv.includes('--strict');
const envFile = process.env.NPL_CHECK_ENV_FILE || (strict ? '.env.production' : '.env');
const fileEnv = readEnvFile(envFile);
const env = process.argv.includes('--allow-process-env') ? { ...fileEnv, ...process.env } : fileEnv;
const chain = targetChain(env);
const rpcUrl = env.BSC_RPC_URL || env.CHAIN_EVENT_RPC_URL || env.EXPO_PUBLIC_BSC_RPC_URL;
const escrowAddress = String(env.EXPO_PUBLIC_ESCROW_ADDRESS || '').trim();
const checks = [];

check('BSC chain is selected', chain.key === 'bsc' && chain.chainId === 56);
check('NPL address is fixed', String(env.EXPO_PUBLIC_NPL_BSC_ADDRESS || FIXED_NPL).toLowerCase() === FIXED_NPL);
check('RPC URL is configured', Boolean(rpcUrl));
if (!rpcUrl) finish();

const provider = new JsonRpcProvider(rpcUrl, 56, { batchMaxCount: 1 });
const network = await provider.getNetwork();
check('RPC chainId is 56', Number(network.chainId) === 56);
const code = await provider.getCode(FIXED_NPL);
check('NPL contract code exists', code !== '0x');

const npl = new Contract(FIXED_NPL, [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function enableOffTrade() view returns (bool)',
  'function preSaleActive() view returns (bool)',
  'function startTradeBlock() view returns (uint256)',
  'function _swapPairList(address) view returns (bool)',
  'function _feeWhiteList(address) view returns (bool)',
  'function preSaleWhiteList(address) view returns (bool)'
], provider);

const [name, symbol, decimals, totalSupply, owner, enableOffTrade, preSaleActive, startTradeBlock] = await Promise.all([
  npl.name(),
  npl.symbol(),
  npl.decimals(),
  npl.totalSupply(),
  npl.owner(),
  npl.enableOffTrade(),
  npl.preSaleActive(),
  npl.startTradeBlock()
]);
check('Token identity is Napoleon Token V2 / NPL', name === 'Napoleon Token V2' && symbol === 'NPL');
check('NPL uses 18 decimals', Number(decimals) === 18);
check('NPL total supply is nonzero', totalSupply > 0n);
check('NPL owner is permanently dead', owner.toLowerCase() === DEAD);
check('NPL public trading is enabled', enableOffTrade === true && startTradeBlock > 0n);
check('NPL presale mode is disabled', preSaleActive === false);

const approveInterface = new Interface(['function approve(address spender,uint256 amount) returns (bool)']);
const approveSpender = /^0x[0-9a-fA-F]{40}$/.test(escrowAddress)
  ? escrowAddress
  : '0x0000000000000000000000000000000000000001';
const approveResult = await provider.call({
  from: '0x0000000000000000000000000000000000000002',
  to: FIXED_NPL,
  data: approveInterface.encodeFunctionData('approve', [approveSpender, (1n << 256n) - 1n])
});
const [approveOk] = approveInterface.decodeFunctionResult('approve', approveResult);
check('MaxUint256 approve eth_call returns true', approveOk === true);

if (/^0x[0-9a-fA-F]{40}$/.test(escrowAddress)) {
  const [escrowCode, isPair, isFeeWhitelisted, isPresaleWhitelisted] = await Promise.all([
    provider.getCode(escrowAddress),
    npl._swapPairList(escrowAddress),
    npl._feeWhiteList(escrowAddress),
    npl.preSaleWhiteList(escrowAddress)
  ]);
  check('Configured Escrow contract code exists', escrowCode !== '0x');
  check('Configured Escrow is not an NPL swap pair', isPair === false);
  check('Configured Escrow does not rely on NPL fee whitelist', isFeeWhitelisted === false);
  check('Configured Escrow does not rely on NPL presale whitelist', isPresaleWhitelisted === false);
} else {
  check('Escrow address is configured for compatibility check', !strict);
}

finish();

function check(name, ok) {
  checks.push({ name, level: ok ? 'pass' : 'fail' });
}

function finish() {
  const failed = checks.filter((entry) => entry.level === 'fail');
  console.log(JSON.stringify({
    ok: failed.length === 0,
    chainId: chain.chainId,
    nplAddress: FIXED_NPL,
    envFile,
    escrowAddress: /^0x[0-9a-fA-F]{40}$/.test(escrowAddress) ? escrowAddress : null,
    sendsTransactions: false,
    privateKeyPrinted: false,
    checks
  }, null, 2));
  if (failed.length) process.exit(1);
  process.exit(0);
}
