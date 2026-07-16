import {
  artifactVersion,
  type CmsPublicItem,
  type GuaranteeDepositProjection,
  type MerchantFinanceProjection,
  type MerchantReceivableStatement,
  type MerchantReceivableStatementPage,
  type SettlementIntentProjection,
  type SettlementListProjection,
  type SettlementRequestProjection,
} from '@abu24k/core-artifacts';

export const merchantWallet = '0x1111111111111111111111111111111111111111';
export const custodySafe = '0x2222222222222222222222222222222222222222';
export const operationsSafe = '0x3333333333333333333333333333333333333333';
export const usdtAddress = '0x55d398326f99059ff775485246999027b3197955';

const hash = (character: string) => `0x${character.repeat(64)}`;

export const requestedSettlement = settlementRequest({
  requestId: 'settlement-request-requested',
  state: 'REQUESTED',
  amount: '12000000000000000000',
});

export const batchedSettlement = settlementRequest({
  requestId: 'settlement-request-batched',
  state: 'BATCHED',
  amount: '7000000000000000000',
  batchId: 'safe-batch-7',
});

export const settledSettlement = settlementRequest({
  requestId: 'settlement-request-settled',
  state: 'SETTLED',
  amount: '90000000000000000000',
  batchId: 'safe-batch-6',
  finalSafeTxHash: hash('9'),
});

export const settlementList: SettlementListProjection = {
  artifactVersion,
  wallet: merchantWallet,
  balances: [
    { asset: 'USDT', purpose: 'MERCHANT_RECEIVABLE', rewardSubtype: null, state: 'LOCKED', amount: '25000000000000000000' },
    { asset: 'USDT', purpose: 'MERCHANT_RECEIVABLE', rewardSubtype: null, state: 'AVAILABLE', amount: '45000000000000000000' },
    { asset: 'USDT', purpose: 'MERCHANT_RECEIVABLE', rewardSubtype: null, state: 'REQUESTED', amount: '12000000000000000000' },
    { asset: 'USDT', purpose: 'MERCHANT_RECEIVABLE', rewardSubtype: null, state: 'BATCHED', amount: '7000000000000000000' },
    { asset: 'USDT', purpose: 'MERCHANT_RECEIVABLE', rewardSubtype: null, state: 'SETTLED', amount: '90000000000000000000' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'GENESIS', state: 'AVAILABLE', amount: '2101' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'DIRECT_REFERRAL', state: 'LOCKED', amount: '2102' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'DISTRICT', state: 'REQUESTED', amount: '2103' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'CITY', state: 'BATCHED', amount: '2104' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'PROVINCE', state: 'SETTLED', amount: '2105' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'REGION', state: 'AVAILABLE', amount: '2106' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'OPERATIONS', state: 'LOCKED', amount: '2107' },
    { asset: 'NPL', purpose: 'REWARD_LIABILITY', rewardSubtype: 'ROUNDING_REMAINDER', state: 'AVAILABLE', amount: '2108' },
  ],
  points: [
    { pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'LOCKED', amount: '8800', transferable: false },
    { pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'AVAILABLE', amount: '3600', transferable: false },
  ],
  requests: [requestedSettlement, batchedSettlement, settledSettlement],
};

export const seckillReceivableStatement = receivableStatement({
  hashCharacter: 'a',
  orderKind: 'SECKILL',
  orderState: 'FULFILLED',
  currentReceivableUsdt: '0',
  removedFromReceivableUsdt: '9000',
  lifecycleState: 'SETTLED',
  settlementState: 'SETTLED',
  finalSafeTxHash: hash('b'),
});

export const ordinaryReceivableStatement = receivableStatement({
  hashCharacter: 'c',
  orderKind: 'ORDINARY',
  orderState: 'SHIPPED',
  currentReceivableUsdt: '9000',
  removedFromReceivableUsdt: '0',
  lifecycleState: 'LOCKED',
});

export const fallbackReceivableStatement = receivableStatement({
  hashCharacter: 'd',
  orderKind: 'FALLBACK_RETAIL',
  orderState: 'FULFILLED',
  currentReceivableUsdt: '9000',
  removedFromReceivableUsdt: '0',
  lifecycleState: 'AVAILABLE',
});

export const merchantReceivableStatements: MerchantReceivableStatementPage = {
  artifactVersion,
  merchantId: 'merchant-1',
  settlementWallet: merchantWallet,
  statements: [seckillReceivableStatement, ordinaryReceivableStatement],
  nextCursor: {
    createdAt: ordinaryReceivableStatement.createdAt,
    orderId: ordinaryReceivableStatement.orderId,
  },
};

export const merchantReceivableStatementsNext: MerchantReceivableStatementPage = {
  artifactVersion,
  merchantId: 'merchant-1',
  settlementWallet: merchantWallet,
  statements: [fallbackReceivableStatement],
  nextCursor: null,
};

export const settlementIntent: SettlementIntentProjection = {
  intent: {
    intentId: hash('c'),
    artifactVersion,
    wallet: merchantWallet,
    recipient: merchantWallet,
    rail: 'MERCHANT_USDT',
    asset: usdtAddress,
    safeAddress: custodySafe,
    amount: '45000000000000000000',
    itemsHash: hash('d'),
    nonce: '3',
    deadline: 1_900_000_000,
  },
  digest: hash('e'),
  typedData: {
    domain: {
      name: 'Abu24KV2Settlement',
      version: '2',
      chainId: 56,
      verifyingContract: custodySafe,
    },
    types: {
      SettlementRequest: [
        { name: 'intentId', type: 'bytes32' },
        { name: 'artifactVersion', type: 'string' },
        { name: 'wallet', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'rail', type: 'string' },
        { name: 'asset', type: 'address' },
        { name: 'safeAddress', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'itemsHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'SettlementRequest',
    message: {
      intentId: hash('c'),
      artifactVersion,
      wallet: merchantWallet,
      recipient: merchantWallet,
      rail: 'MERCHANT_USDT',
      asset: usdtAddress,
      safeAddress: custodySafe,
      amount: '45000000000000000000',
      itemsHash: hash('d'),
      nonce: '3',
      deadline: 1_900_000_000,
    },
  },
  items: [{
    itemIndex: 0,
    orderId: hash('1'),
    accountId: 'merchant:merchant-1:usdt',
    backingSafeAddress: custodySafe,
    amount: '45000000000000000000',
    itemHash: hash('f'),
  }],
  createdAt: '2026-07-15T08:00:00.000Z',
};

export const merchantFinance: MerchantFinanceProjection = {
  merchant: {
    merchant_id: 'merchant-1',
    status: 'APPROVED',
    guarantee_status: 'READY',
    settlement_wallet: merchantWallet,
  },
  guarantee: {
    backing_safe_address: operationsSafe,
    balance_usdt: '1200000000000000000000',
    minimum_usdt: '1000000000000000000000',
    source_evidence_hash: hash('a'),
    updated_at: '2026-07-15T07:59:00.000Z',
  },
  guaranteeDeposits: [
    {
      deposit_id: 'guarantee-final',
      policy_version: '8',
      token_address: usdtAddress,
      operations_safe_address: operationsSafe,
      expected_amount_usdt: '1200000000000000000000',
      transaction_hash: hash('4'),
      state: 'FINAL',
      observed_block_number: '51000000',
      observed_block_hash: hash('5'),
      observed_log_index: 2,
      confirmations: 15,
      transfer_evidence_hash: hash('6'),
      created_at: '2026-07-15T06:00:00.000Z',
      updated_at: '2026-07-15T06:08:00.000Z',
      finalized_at: '2026-07-15T06:08:00.000Z',
    },
    {
      deposit_id: 'guarantee-reorged',
      policy_version: '7',
      token_address: usdtAddress,
      operations_safe_address: operationsSafe,
      expected_amount_usdt: '100000000000000000000',
      transaction_hash: hash('7'),
      state: 'REORGED',
      observed_block_number: '50990000',
      observed_block_hash: hash('8'),
      observed_log_index: 1,
      confirmations: 2,
      transfer_evidence_hash: null,
      created_at: '2026-07-14T06:00:00.000Z',
      updated_at: '2026-07-14T06:03:00.000Z',
      finalized_at: null,
    },
  ],
  debt: {
    incurred_usdt: '300000000000000000000',
    recovered_usdt: '100000000000000000000',
    outstanding_usdt: '200000000000000000000',
    latest_evidence_hash: hash('b'),
    updated_at: '2026-07-15T07:30:00.000Z',
  },
  takeovers: [{
    case_id: 'takeover-1',
    order_id: hash('2'),
    state: 'FUNDED',
    required_usdt: '500000000000000000000',
    guarantee_used_usdt: '200000000000000000000',
    merchant_available_used_usdt: '100000000000000000000',
    future_proceeds_used_usdt: '50000000000000000000',
    platform_advance_usdt: '150000000000000000000',
    disbursed_usdt: '500000000000000000000',
    merchant_debt_usdt: '150000000000000000000',
    evidence_hash: hash('3'),
    opened_at: '2026-07-14T08:00:00.000Z',
    closed_at: null,
    updated_at: '2026-07-15T07:00:00.000Z',
  }],
};

export const guaranteeDepositResult: GuaranteeDepositProjection = {
  depositId: 'guarantee-submitted',
  merchantId: 'merchant-1',
  policyVersion: 9,
  transactionHash: hash('0'),
  expectedAmountUsdt: '1000000000000000000000',
  operationsSafeAddress: operationsSafe,
  state: 'SUBMITTED',
  confirmations: 0,
};

export const cmsRules: CmsPublicItem = {
  entryId: 'cms:merchant-rules',
  versionId: 'cms:merchant-rules:v8',
  version: 8,
  slug: 'merchant-seckill-rules',
  contentType: 'SECKILL_RULES',
  placement: 'MERCHANT_HELP_RULES',
  locale: 'zh-CN',
  content: {
    type: 'doc',
    children: [
      {
        type: 'heading',
        level: 2,
        children: [{ type: 'text', text: '秒杀履约与结算', marks: ['bold'] }],
      },
      {
        type: 'paragraph',
        children: [{ type: 'text', text: '已签收货款从 Locked 进入 Available，再由商家钱包签名申请结算。', marks: [] }],
      },
    ],
  },
  contentHash: hash('a'),
  audience: { type: 'ALL' },
  startsAt: null,
  endsAt: null,
  frequencyCap: null,
  policyVersion: '8',
};

function settlementRequest(input: {
  requestId: string;
  state: SettlementRequestProjection['state'];
  amount: string;
  batchId?: string;
  finalSafeTxHash?: string;
}): SettlementRequestProjection {
  return {
    request_id: input.requestId,
    intent_id: hash('c'),
    artifact_version: artifactVersion,
    wallet_address: merchantWallet,
    recipient_address: merchantWallet,
    rail: 'MERCHANT_USDT',
    asset: 'USDT',
    asset_address: usdtAddress,
    safe_address: custodySafe,
    amount: input.amount,
    items_hash: hash('d'),
    intent_digest: hash('e'),
    signature_hash: hash('f'),
    state: input.state,
    batch_id: input.batchId ?? null,
    final_safe_tx_hash: input.finalSafeTxHash ?? null,
    final_execution_tx_hash: input.finalSafeTxHash ?? null,
    requested_at: '2026-07-15T08:01:00.000Z',
    batched_at: input.batchId ? '2026-07-15T08:02:00.000Z' : null,
    settled_at: input.finalSafeTxHash ? '2026-07-15T08:10:00.000Z' : null,
    items: [{
      item_index: 0,
      order_id: hash('1'),
      account_id: 'merchant:merchant-1:usdt',
      backing_safe_address: custodySafe,
      amount: input.amount,
      requested_journal_id: `journal:${input.requestId}:requested`,
      batched_journal_id: input.batchId ? `journal:${input.requestId}:batched` : null,
      settled_journal_id: input.finalSafeTxHash ? `journal:${input.requestId}:settled` : null,
    }],
    transitions: [{
      transition_id: `transition:${input.requestId}`,
      request_item_index: 0,
      batch_id: input.batchId ?? null,
      transition_sequence: '1',
      transition_type: input.state,
      journal_id: `journal:${input.requestId}:transition`,
      created_at: '2026-07-15T08:01:00.000Z',
    }],
  };
}

function receivableStatement(input: {
  hashCharacter: string;
  orderKind: MerchantReceivableStatement['orderKind'];
  orderState: MerchantReceivableStatement['orderState'];
  currentReceivableUsdt: string;
  removedFromReceivableUsdt: string;
  lifecycleState: MerchantReceivableStatement['receivableLifecycle'][number]['state'];
  settlementState?: MerchantReceivableStatement['settlementRefs'][number]['state'];
  finalSafeTxHash?: string;
}): MerchantReceivableStatement {
  const orderId = hash(input.hashCharacter);
  const lifecycleJournalId = `journal:${input.hashCharacter}:lifecycle`;
  const settlementRequestId = hash(input.hashCharacter === 'a' ? 'e' : 'f');
  return {
    orderId,
    productId: `product-${input.hashCharacter}`,
    skuId: `sku-${input.hashCharacter}`,
    quantity: '1',
    orderState: input.orderState,
    paymentTxHash: hash(input.hashCharacter === 'a' ? '1' : '2'),
    paymentFinalizedAt: '2026-07-15T08:00:00.000Z',
    fulfilledAt: input.orderState === 'FULFILLED' ? '2026-07-15T09:00:00.000Z' : null,
    createdAt: input.hashCharacter === 'a'
      ? '2026-07-15T07:59:00.000Z'
      : input.hashCharacter === 'c'
        ? '2026-07-14T07:59:00.000Z'
        : '2026-07-13T07:59:00.000Z',
    orderKind: input.orderKind,
    frozenAmounts: {
      listPriceUsdt: '12000',
      buyerPaidUsdt: '8400',
      merchantBaseReceivableUsdt: '10000',
      merchantConcessionAmount: '1000',
      merchantNetReceivableUsdt: '9000',
    },
    currentReceivableUsdt: input.currentReceivableUsdt,
    removedFromReceivableUsdt: input.removedFromReceivableUsdt,
    receivableLifecycle: [{
      state: input.lifecycleState,
      amount: input.lifecycleState === 'SETTLED' ? input.removedFromReceivableUsdt : input.currentReceivableUsdt,
      journalIds: [lifecycleJournalId],
    }],
    journalEvidence: [{
      journalId: lifecycleJournalId,
      eventType: input.lifecycleState === 'LOCKED' ? 'PAYMENT_FINAL' : 'FULFILLMENT_FINAL',
      state: input.lifecycleState,
      delta: input.lifecycleState === 'SETTLED' ? '-9000' : '9000',
      sourceKind: 'ORDER',
      sourceReferenceHash: orderId,
      createdAt: '2026-07-15T09:00:00.000Z',
    }],
    settlementRefs: input.settlementState ? [{
      requestId: settlementRequestId,
      amount: '9000',
      state: input.settlementState,
      batchId: hash('6'),
      finalSafeTxHash: input.finalSafeTxHash ?? null,
      finalExecutionTxHash: input.finalSafeTxHash ?? null,
      journals: {
        requested: `journal:${input.hashCharacter}:requested`,
        batched: `journal:${input.hashCharacter}:batched`,
        settled: input.finalSafeTxHash ? `journal:${input.hashCharacter}:settled` : null,
      },
      requestedAt: '2026-07-15T09:05:00.000Z',
      batchedAt: '2026-07-15T09:06:00.000Z',
      settledAt: input.finalSafeTxHash ? '2026-07-15T09:15:00.000Z' : null,
    }] : [],
  };
}
