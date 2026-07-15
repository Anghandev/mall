import {
  artifactVersion,
  type MediaAssetProjection,
  type MediaReadAccessProjection,
  type MediaUploadIntentProjection,
  type MerchantAuditExport,
  type MerchantAuditList,
  type MerchantProfile,
} from '@abu24k/core-artifacts';
import { merchantWallet } from './catalog-fixtures';

export const merchantProfile: MerchantProfile = {
  artifactVersion,
  merchantId: 'merchant-1',
  shopName: '阿步金店',
  logoAssetId: `0x${'8'.repeat(64)}`,
  settlementWallet: merchantWallet,
  settlementWalletMutable: false,
  version: 3,
  updatedAt: '2026-07-15T09:30:00.000Z',
};

export const merchantAudit: MerchantAuditList = {
  entries: [
    {
      entryId: 'audit-merchant-2',
      operationTime: '2026-07-15T10:00:00.000Z',
      operationType: 'SettlementRequestAuthorized',
      module: 'SETTLEMENT_REQUEST',
      detail: 'SettlementRequestAuthorized / SETTLEMENT_REQUEST / settlement-2',
      signatureHash: `0x${'4'.repeat(64)}`,
      safeOrChainTxHash: `0x${'5'.repeat(64)}`,
      entryHash: '6'.repeat(64),
    },
    {
      entryId: 'audit-merchant-1',
      operationTime: '2026-07-15T09:30:00.000Z',
      operationType: 'MerchantProfileUpdated',
      module: 'MERCHANT_PROFILE',
      detail: 'MerchantProfileUpdated / MERCHANT_PROFILE / merchant-1',
      signatureHash: null,
      safeOrChainTxHash: null,
      entryHash: '7'.repeat(64),
    },
  ],
  proofScope: 'MERCHANT_SCOPED_ENTRY_HASHES',
  historyStatus: 'PARTIAL_PRE_MERCHANT_SCOPE',
  chainProof: { merchantId: 'merchant-1', entries: 2 },
  nextCursor: null,
};

export const merchantAuditExport: MerchantAuditExport = {
  contentType: 'text/csv; charset=utf-8',
  filename: 'merchant-audit-2026-07-01-2026-07-15.csv',
  entryCount: 2,
  csv: 'operationTime,operationType\n2026-07-15T10:00:00.000Z,SettlementRequestAuthorized\n',
};

export const merchantLogoUploadIntent: MediaUploadIntentProjection = {
  artifactVersion,
  uploadIntentId: `0x${'9'.repeat(64)}`,
  ownerWallet: merchantWallet,
  purpose: 'MERCHANT_LOGO',
  resourceType: 'MERCHANT',
  resourceId: 'merchant-1',
  contentType: 'image/png',
  sizeBytes: '4',
  contentSha256: `0x${'a'.repeat(64)}`,
  state: 'UPLOADED',
  expiresAt: '2026-07-15T10:05:00.000Z',
  method: 'PUT',
  uploadUrl: 'https://media.example.test/merchant-logo',
  headers: { 'content-type': 'image/png' },
  providerReferenceHash: `0x${'b'.repeat(64)}`,
  writeOnce: true,
};

export const merchantLogoAsset: MediaAssetProjection = {
  artifactVersion,
  assetId: `0x${'c'.repeat(64)}`,
  uploadIntentId: merchantLogoUploadIntent.uploadIntentId,
  ownerWallet: merchantWallet,
  purpose: 'MERCHANT_LOGO',
  resourceType: 'MERCHANT',
  resourceId: 'merchant-1',
  contentType: 'image/png',
  sizeBytes: '4',
  contentSha256: merchantLogoUploadIntent.contentSha256,
  providerEvidenceHash: `0x${'d'.repeat(64)}`,
  objectVersionHash: `0x${'e'.repeat(64)}`,
  createdAt: '2026-07-15T10:01:00.000Z',
};

export const merchantLogoReadAccess: MediaReadAccessProjection = {
  artifactVersion,
  assetId: merchantLogoAsset.assetId,
  purpose: 'MERCHANT_LOGO',
  resourceType: 'MERCHANT',
  resourceId: 'merchant-1',
  contentType: 'image/png',
  sizeBytes: '4',
  contentSha256: merchantLogoAsset.contentSha256,
  objectVersionHash: merchantLogoAsset.objectVersionHash,
  accessScope: 'AUTHENTICATED',
  method: 'GET',
  readUrl: 'https://media.example.test/merchant-logo/read',
  expiresAt: '2026-07-15T10:06:00.000Z',
  providerReferenceHash: `0x${'f'.repeat(64)}`,
};
