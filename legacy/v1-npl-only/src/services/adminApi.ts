import { API_BASE_URL } from '../config/web3';

export type AdminDashboard = {
  modules: string[];
  stats: {
    merchants: number;
    pendingReviews: number;
    seckillSessions: number;
    riskAlerts: number;
    prizePoolNpl: number;
  };
};

export type AdminAuditLog = {
  id: number;
  role: string;
  action: string;
  target: string;
  actorAddress: string;
  createdAt: string;
};

export type AdminSearchResult = {
  filters: Record<string, unknown>;
  results: Record<string, unknown[]>;
  batchActions: string[];
};

export type AdminBatchResult = {
  ok: boolean;
  action: 'admin.batch.run';
  batch: {
    id: string;
    operation: string;
    resource: string;
    affected: number;
    exportFile?: string;
    status: 'Accepted' | 'Partial' | 'Failed';
    results?: Array<{
      targetId: string;
      ok: boolean;
      status: string;
      approvedProductId?: string;
      error?: string;
    }>;
  };
};

export type CircuitScope = 'orders' | 'seckill' | 'claims' | 'force-cutoff';

export type CircuitResult = {
  ok: boolean;
  action: string;
  target: string;
  scope: CircuitScope;
  state: 'Paused' | 'Resumed';
  redLight: boolean;
  audit: 'written';
};

export async function fetchAdminDashboard(token: string): Promise<AdminDashboard> {
  return normalizeAdminDashboard(await adminJson('/api/admin/dashboard', token));
}

export async function fetchAdminAuditLogs(token: string): Promise<AdminAuditLog[]> {
  const payload = await adminJson('/api/admin/audit-logs', token);
  return Array.isArray(payload) ? payload.map(normalizeAuditLog) : [];
}

export async function fetchAdminSearch(token: string, query: { q?: string; status?: string; from?: string; to?: string } = {}): Promise<AdminSearchResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  return adminJson(`/api/admin/search${params.size ? `?${params}` : ''}`, token) as Promise<AdminSearchResult>;
}

export async function runAdminBatch(token: string, body: { operation: string; resource: string; targetIds: string[]; secondaryMessage: string; secondarySignature: string }): Promise<AdminBatchResult> {
  return adminJson('/api/admin/batch', token, 'POST', body) as Promise<AdminBatchResult>;
}

export async function saveAdminRatioConfig(token: string, body: { bnmRebateRate?: number; nplBurnBps: number; beneficiaries?: Array<{ address: string; weightBps: number; role?: string }>; secondaryMessage: string; secondarySignature: string }): Promise<unknown> {
  return adminJson('/api/admin/ratio-config', token, 'POST', body);
}

export async function setCircuitBreaker(token: string, scope: CircuitScope, enabled: boolean, signature: { secondaryMessage: string; secondarySignature: string }): Promise<CircuitResult> {
  const path = scope === 'force-cutoff' ? '/api/admin/seckill/force-cutoff' : `/api/admin/pause-${scope === 'claims' ? 'claims' : scope}`;
  return adminJson(path, token, 'POST', { enabled, ...signature }) as Promise<CircuitResult>;
}

async function adminJson(path: string, token: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`平台后台接口不可用：HTTP ${response.status}`);
  return response.json();
}

function normalizeAdminDashboard(raw: unknown): AdminDashboard {
  const row = raw as Partial<AdminDashboard>;
  return {
    modules: Array.isArray(row.modules) ? row.modules.map(String) : [],
    stats: {
      merchants: Number(row.stats?.merchants || 0),
      pendingReviews: Number(row.stats?.pendingReviews || 0),
      seckillSessions: Number(row.stats?.seckillSessions || 0),
      riskAlerts: Number(row.stats?.riskAlerts || 0),
      prizePoolNpl: Number(row.stats?.prizePoolNpl || 0)
    }
  };
}

function normalizeAuditLog(raw: unknown): AdminAuditLog {
  const row = raw as Partial<AdminAuditLog> & Record<string, unknown>;
  return {
    id: Number(row.id || 0),
    role: String(row.role || ''),
    action: String(row.action || ''),
    target: String(row.target || ''),
    actorAddress: String(row.actorAddress || row.actor_address || ''),
    createdAt: String(row.createdAt || row.created_at || '')
  };
}
