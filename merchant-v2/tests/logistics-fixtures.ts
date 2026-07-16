import {
  artifactVersion,
  type PrintJob,
  type PrinterBinding,
  type PrinterBindingChallenge,
  type WaybillBatchResult,
} from '@abu24k/core-artifacts';
import { merchantId, merchantWallet, storeId } from './catalog-fixtures';
import { deliveryOrderId, pickupOrderId } from './fulfillment-fixtures';

export const printerChallenge: PrinterBindingChallenge = {
  artifactVersion,
  challengeId: hash('a'),
  storeId,
  merchantId,
  signer: merchantWallet,
  expiresAt: '2099-01-01T00:00:00.000Z',
  typedData: {
    domain: {
      name: 'Abu24KMerchantPrinter',
      version: '2',
      chainId: 56,
      verifyingContract: '0x3333333333333333333333333333333333333333',
    },
    types: {
      MerchantPrinterBinding: [
        { name: 'storeId', type: 'string' },
        { name: 'merchantId', type: 'string' },
        { name: 'provider', type: 'string' },
        { name: 'deviceIdHash', type: 'bytes32' },
        { name: 'oldValueHash', type: 'bytes32' },
        { name: 'newValueHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'MerchantPrinterBinding',
    message: {
      storeId,
      merchantId,
      provider: 'FEIE',
      deviceIdHash: hash('b'),
      oldValueHash: hash('0'),
      newValueHash: hash('c'),
      nonce: '42',
      deadline: '4070908800',
    },
  },
  digest: hash('d'),
};

export const printerBinding: PrinterBinding = {
  artifactVersion,
  bindingId: hash('e'),
  storeId,
  merchantId,
  provider: 'FEIE',
  deviceId: 'FEIE-DEVICE-001',
  bindingHash: hash('f'),
  version: 2,
  verifiedByWallet: merchantWallet,
  signatureHash: hash('1'),
  updatedAt: '2026-07-16T08:00:00.000Z',
};

export const waybillBatchResult: WaybillBatchResult = {
  artifactVersion,
  batchId: hash('2'),
  items: [{
    artifactVersion,
    requestId: hash('3'),
    batchId: hash('2'),
    merchantId,
    orderId: deliveryOrderId,
    storeId,
    provider: 'KUAIDI100',
    carrierCode: 'SF',
    state: 'COMPLETED',
    providerReference: 'kuaidi-task-24k',
    trackingNumber: 'SF1234567890',
    trackingNumberHash: hash('4'),
    shipmentEvidenceHash: hash('5'),
    printJobId: hash('6'),
    errorCode: null,
    updatedAt: '2026-07-16T08:02:00.000Z',
  }],
};

export const waybillPrintJob: PrintJob = {
  artifactVersion,
  printJobId: hash('6'),
  merchantId,
  orderId: deliveryOrderId,
  storeId,
  jobKind: 'WAYBILL',
  provider: 'FEIE',
  deviceId: 'FEIE-DEVICE-001',
  copyCount: 1,
  contentHash: hash('7'),
  state: 'RETRYABLE',
  attempts: 1,
  providerReference: null,
  errorCode: 'PROVIDER_TIMEOUT',
  nextAttemptAt: '2026-07-16T08:10:00.000Z',
  createdAt: '2026-07-16T08:02:00.000Z',
  updatedAt: '2026-07-16T08:03:00.000Z',
};

export const pickupPrintJob: PrintJob = {
  artifactVersion,
  printJobId: hash('8'),
  merchantId,
  orderId: pickupOrderId,
  storeId: 'store-dalian-1',
  jobKind: 'PICKUP_RECEIPT',
  provider: 'YILIANYUN',
  deviceId: 'YLY-DEVICE-002',
  copyCount: 2,
  contentHash: hash('9'),
  state: 'ACCEPTED',
  attempts: 1,
  providerReference: 'yly-print-24k',
  errorCode: null,
  nextAttemptAt: null,
  createdAt: '2026-07-16T08:04:00.000Z',
  updatedAt: '2026-07-16T08:05:00.000Z',
};

function hash(character: string) {
  return `0x${character.repeat(64)}`;
}
