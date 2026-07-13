import { hexlify, parseUnits, toUtf8Bytes } from 'ethers';
import { BSC_CHAIN_ID, ESCROW_ADDRESS, NPL_BSC_ADDRESS } from '../config/web3';
import { buildAllowanceCall, buildApproveTokenMaxTransaction, erc20Interface } from './paymentPayload';
export { waitForTransactionReceipt } from './txReceipt';
import type { AllowanceCheck, WalletTransaction } from './api';
import type { Order } from '../types';

export type WalletProvider = {
  request<T = unknown>(args: { method: string; params?: unknown[] | Record<string, unknown> | object }): Promise<T>;
};

export function isOnBsc(chainId?: string) {
  return Number(chainId) === BSC_CHAIN_ID;
}

export async function getNplAllowance(provider: WalletProvider, owner: string, spenderAddress = ESCROW_ADDRESS) {
  assertConfigured();
  const result = await provider.request<string>({
    method: 'eth_call',
    params: [buildAllowanceCall(owner, NPL_BSC_ADDRESS, spenderAddress), 'latest']
  });
  const [allowance] = erc20Interface.decodeFunctionResult('allowance', result);
  return BigInt(allowance.toString());
}

export async function approveNplUnlimited(provider: WalletProvider, from: string) {
  assertConfigured();
  return provider.request<string>({
    method: 'eth_sendTransaction',
    params: [buildApproveTokenMaxTransaction(from, NPL_BSC_ADDRESS, ESCROW_ADDRESS)]
  });
}

export async function needsNplApproval(provider: WalletProvider, from: string, order: Order) {
  assertConfigured();
  const requiredAmount = parseUnits(order.amountNpl, 18);
  const allowance = await getNplAllowance(provider, from);
  return allowance < requiredAmount;
}

export async function readAllowanceWei(provider: WalletProvider, check: AllowanceCheck) {
  const result = await provider.request<string>({
    method: 'eth_call',
    params: [{ to: check.to || check.tokenAddress, data: check.data }, 'latest']
  });
  return BigInt(result || '0x0');
}

export async function sendWalletTransaction(provider: WalletProvider, transaction: WalletTransaction) {
  const payload: Record<string, string> = {
    to: transaction.to,
    value: transaction.value || '0x0',
    data: transaction.data
  };
  if (transaction.from) payload.from = transaction.from;
  return provider.request<string>({ method: 'eth_sendTransaction', params: [payload] });
}

export async function personalSign(provider: WalletProvider, address: string, message: string) {
  return provider.request<string>({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(message)), address] });
}

function assertConfigured() {
  if (!ESCROW_ADDRESS) {
    throw new Error('还没有配置 EXPO_PUBLIC_ESCROW_ADDRESS，先部署或填写 24K PaymentEscrow 合约地址。');
  }
}
