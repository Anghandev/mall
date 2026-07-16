import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['src', 'dist'];
const forbidden = [
  { pattern: /legacy\/v1-npl-only/i, reason: 'V2 runtime references legacy source' },
  { pattern: /__MALL_TEST_FIXTURE__/i, reason: 'test fixture marker entered production' },
  { pattern: /2\.0\.0-rc\.2/i, reason: 'stale coordinated artifact entered production' },
  { pattern: /2\.0\.0-fulfillment\.1/i, reason: 'stale fulfillment checkpoint entered production' },
  { pattern: /2\.0\.0-settlement-admin\.(?:[1-9]|10)(?!\d)/i, reason: 'stale settlement checkpoint entered production' },
  { pattern: /maxSizeBytes/i, reason: 'retired media upload field entered production' },
  { pattern: /canonical evidence 生成\/上传契约尚未发布/i, reason: 'retired evidence placeholder entered production' },
  { pattern: /PaymentEscrowV2|ClaimVaultV2|BNMTokenV2|CLAIM_[A-Z_]+/i, reason: 'retired funds surface entered production' },
  { pattern: /申请退款|强制退款|无理由退款/i, reason: 'business-refund copy entered production' },
  { pattern: /\/v2\/admin\/global\/resources/i, reason: 'Admin global search entered Mall production' },
  { pattern: /\/v2\/admin\/global\/exports/i, reason: 'Admin resource export entered Mall production' },
  { pattern: /\/v2\/admin\/catalog\/products\/batch-tags/i, reason: 'Admin product batch tags entered Mall production' },
  { pattern: /adminGlobalResourceSearchHttp|adminResourceExportHttp|adminProductBatchTaggingHttp/i, reason: 'Admin-only capability metadata entered Mall production' },
  { pattern: /\/v2\/admin\/(?:payments\/\{orderId\}|settlement-(?:requests|batches))/i, reason: 'Admin clearing route entered Mall production' },
  { pattern: /getAdminPaymentProjection|listAdminSettlementRequests|getAdminSettlementRequest|listAdminSettlementBatches|getAdminSettlementBatch/i, reason: 'Admin clearing operation entered Mall production' },
  { pattern: /AdminSettlement(?:Request|Batch)(?:List|Detail)/i, reason: 'Admin clearing schema entered Mall production' },
  { pattern: /\/v2\/(?:admin|merchant)\/takeover-cases/i, reason: 'Admin or Merchant takeover route entered Mall production' },
  { pattern: /listAdminTakeoverCases|getAdminTakeoverCase|listTakeoverCandidates|assignTakeoverReplacementMerchant|listMerchantTakeoverCases|getMerchantTakeoverCase/i, reason: 'Admin or Merchant takeover operation entered Mall production' },
  { pattern: /TakeoverAssignment(?:Request|Result)?|TakeoverCandidate(?:List)?|TakeoverCase(?:Funding|Cursor|List|Detail|Transition)?|TakeoverOrderSummary/i, reason: 'Admin or Merchant takeover schema entered Mall production' },
  { pattern: /takeoverCaseManagementHttp|replacementMerchantFulfillment/i, reason: 'Admin or Merchant takeover capability entered Mall production' },
  { pattern: /\/v2\/merchant\/orders\/exports/i, reason: 'Merchant order export entered Mall production' },
  { pattern: /exportMerchantOrders|merchantOrderExportHttp/i, reason: 'Merchant order export capability entered Mall production' },
  { pattern: /MerchantOrderExport(?:Request|Filters)?/i, reason: 'Merchant order export PII schema entered Mall production' },
];

for (const root of roots) {
  for (const file of await walk(root)) {
    if (!['.js', '.css', '.html', '.ts', '.tsx'].includes(extname(file))) continue;
    const content = await readFile(file, 'utf8');
    for (const check of forbidden) {
      if (check.pattern.test(content)) {
        throw new Error(`${check.reason}: ${file}`);
      }
    }
  }
}

console.log('Mall production bundle check passed');

async function walk(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}
