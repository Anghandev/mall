import { TypedDataEncoder, keccak256, toUtf8Bytes } from 'ethers';
import { BSC_CHAIN_ID } from './enums.ts';

export const concessionPreviewTypes = {
  MerchantConcessionPreview: [
    { name: 'previewHash', type: 'bytes32' },
    { name: 'previewId', type: 'bytes32' },
    { name: 'productIdHash', type: 'bytes32' },
    { name: 'policyVersion', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};

export function concessionPreviewAuthorization(input: {
  previewHash: string;
  previewId: string;
  productId: string;
  policyVersion: number;
  expiresAt: number;
}) {
  const domain = Object.freeze({
    name: 'Abu24KCatalog',
    version: '2',
    chainId: BSC_CHAIN_ID,
  });
  const message = Object.freeze({
    previewHash: input.previewHash,
    previewId: input.previewId,
    productIdHash: keccak256(toUtf8Bytes(input.productId)),
    policyVersion: input.policyVersion,
    expiresAt: input.expiresAt,
  });
  return Object.freeze({
    domain,
    types: concessionPreviewTypes,
    primaryType: 'MerchantConcessionPreview' as const,
    message,
    digest: TypedDataEncoder.hash(domain, concessionPreviewTypes, message),
  });
}
