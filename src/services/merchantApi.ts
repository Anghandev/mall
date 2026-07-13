import { API_BASE_URL } from '../config/web3';
import type { ClaimRecord, FulfillmentMode, Store } from '../types';

export type MerchantDashboard = {
  merchant: string;
  modules: string[];
  stats: {
    submitted: number;
    lockedListings: number;
    pendingShipments: number;
    pickupVerifications: number;
    claimableNpl: number;
  };
};

export type MerchantProductSubmission = {
  id: string;
  title: string;
  status: 'Draft' | 'PendingReview' | 'Approved' | 'Rejected' | 'Scheduled' | 'Live' | 'SoldOut';
  locked: boolean;
};

export type MerchantOrderRow = {
  orderId: string;
  status: string;
  fulfillmentMode?: FulfillmentMode;
  regionCode?: string;
};

export async function fetchMerchantDashboard(token: string): Promise<MerchantDashboard> {
  return normalizeMerchantDashboard(await merchantJson('/api/merchant/dashboard', token));
}

export async function fetchMerchantOrders(token: string): Promise<MerchantOrderRow[]> {
  const payload = await merchantJson('/api/merchant/orders', token);
  return Array.isArray(payload) ? payload.map(normalizeMerchantOrder) : [];
}

export async function fetchMerchantStores(token: string): Promise<Store[]> {
  const payload = await merchantJson('/api/merchant/stores', token);
  return Array.isArray(payload) ? payload as Store[] : [];
}

export async function requestMerchantClaim(token: string, body: { bucketId: string; secondaryMessage: string; secondarySignature: string }): Promise<ClaimRecord> {
  return merchantJson('/api/merchant/claims', token, 'POST', body) as Promise<ClaimRecord>;
}

export async function updateMerchantProduct(token: string, productId: string, body: { title?: string; sku?: string; priceNpl?: string; secondaryMessage: string; secondarySignature: string }): Promise<MerchantProductSubmission> {
  return merchantJson(`/api/merchant/products/${encodeURIComponent(productId)}`, token, 'PATCH', body) as Promise<MerchantProductSubmission>;
}

export async function lockMerchantProduct(token: string, productId: string, body: { secondaryMessage: string; secondarySignature: string }): Promise<{ ok: boolean; action: string; target: string }> {
  return merchantJson(`/api/merchant/products/${encodeURIComponent(productId)}/lock`, token, 'POST', body) as Promise<{ ok: boolean; action: string; target: string }>;
}

async function merchantJson(path: string, token: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`商家后台接口不可用：HTTP ${response.status}`);
  return response.json();
}

function normalizeMerchantDashboard(raw: unknown): MerchantDashboard {
  const row = raw as Partial<MerchantDashboard>;
  return {
    merchant: String(row.merchant || '24K 商家'),
    modules: Array.isArray(row.modules) ? row.modules.map(String) : [],
    stats: {
      submitted: Number(row.stats?.submitted || 0),
      lockedListings: Number(row.stats?.lockedListings || 0),
      pendingShipments: Number(row.stats?.pendingShipments || 0),
      pickupVerifications: Number(row.stats?.pickupVerifications || 0),
      claimableNpl: Number(row.stats?.claimableNpl || 0)
    }
  };
}

function normalizeMerchantOrder(raw: unknown): MerchantOrderRow {
  const row = raw as Partial<MerchantOrderRow>;
  return {
    orderId: String(row.orderId || ''),
    status: String(row.status || 'Draft'),
    fulfillmentMode: row.fulfillmentMode === 'pickup' ? 'pickup' : 'delivery',
    regionCode: row.regionCode ? String(row.regionCode) : undefined
  };
}
