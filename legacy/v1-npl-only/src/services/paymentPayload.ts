import { Interface, MaxUint256 } from 'ethers';

export const erc20Interface = new Interface([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)'
]);

export const escrowInterface = new Interface([
  'function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)'
]);

export function buildApproveTokenMaxTransaction(from: string, tokenAddress: string, spenderAddress: string) {
  return {
    from,
    to: tokenAddress,
    value: '0x0',
    data: erc20Interface.encodeFunctionData('approve', [spenderAddress, MaxUint256])
  };
}

export function buildAllowanceCall(owner: string, tokenAddress: string, spenderAddress: string) {
  return {
    to: tokenAddress,
    data: erc20Interface.encodeFunctionData('allowance', [owner, spenderAddress])
  };
}
