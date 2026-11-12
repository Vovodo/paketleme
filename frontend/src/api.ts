import {
  ProductionMatchItem,
  ProductionMatchResult,
  StockDashboardSummary,
  StockDashboardViewData,
  StockItem,
  StockItemDetail,
  StockMovementWithItem,
  Suggestions,
  TelegramSettings,
  WarehouseRequestResponse,
} from './types';

function resolveApiBase(): string {
  const raw = ((import.meta.env.VITE_API_URL as string | undefined) || '').trim();
  if (!raw) return '';
  if (typeof window !== 'undefined') {
    const cleanHost = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (cleanHost === window.location.host) {
      return '';
    }
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, '');
  }
  return `https://${raw.replace(/\/+$/, '')}`;
}

const API_BASE = resolveApiBase();

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });

  if (!res.ok) {
    let errMessage = `İşlem başarısız (${res.status})`;
    try {
      const data = await res.json();
      if (data?.detail) {
        errMessage = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
      }
    } catch {
      // ignore json parse error
    }
    throw new Error(errMessage);
  }

  return res.json() as Promise<T>;
}

export const api = {
  createStock(payload: {
    reference: string;
    quantity: number;
    level: string;
    location_note?: string;
    created_by?: string;
  }) {
    return request<StockItem>('/api/stock', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  listStock(params?: {
    q?: string;
    reference?: string;
    level?: string;
    status?: string;
    sort?: string;
  }) {
    const sp = new URLSearchParams();
    if (params?.q) sp.set('q', params.q);
    if (params?.reference) sp.set('reference', params.reference);
    if (params?.level) sp.set('level', params.level);
    if (params?.status) sp.set('status', params.status);
    if (params?.sort) sp.set('sort', params.sort);
    const qs = sp.toString();
    return request<StockItem[]>(`/api/stock${qs ? `?${qs}` : ''}`);
  },

  getDashboard(params?: {
    q?: string;
    reference?: string;
    level?: string;
    status?: string;
    sort?: string;
  }) {
    const sp = new URLSearchParams();
    if (params?.q) sp.set('q', params.q);
    if (params?.reference) sp.set('reference', params.reference);
    if (params?.level) sp.set('level', params.level);
    if (params?.status) sp.set('status', params.status);
    if (params?.sort) sp.set('sort', params.sort);
    const qs = sp.toString();
    return request<StockDashboardViewData>(`/api/stock/dashboard${qs ? `?${qs}` : ''}`);
  },

  getSummary(q?: string) {
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    return request<StockDashboardSummary>(`/api/stock/summary${qs}`);
  },

  getSuggestions() {
    return request<Suggestions>('/api/stock/suggestions');
  },

  matchProduction(queries: ProductionMatchItem[]) {
    return request<ProductionMatchResult[]>('/api/stock/match', {
      method: 'POST',
      body: JSON.stringify({ queries }),
    });
  },

  lookupCode(code: string) {
    return request<StockItemDetail>(`/api/stock/lookup?code=${encodeURIComponent(code)}`);
  },

  scanDeduct(payload: { qr_or_code: string; deduct_quantity?: number; note?: string }) {
    return request<StockItemDetail>('/api/stock/scan-deduct', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  requestFromWarehouse(id: number, requested_note?: string) {
    return request<WarehouseRequestResponse>(`/api/stock/${id}/request`, {
      method: 'POST',
      body: JSON.stringify({ requested_note }),
    });
  },

  cancelWarehouseRequest(id: number) {
    return request<StockItem>(`/api/stock/${id}/cancel-request`, {
      method: 'POST',
    });
  },

  restoreStock(id: number) {
    return request<StockItem>(`/api/stock/${id}/restore`, {
      method: 'POST',
    });
  },

  updateStock(
    id: number,
    payload: {
      reference?: string;
      level?: string;
      remaining_quantity?: number;
      location_note?: string;
    }
  ) {
    return request<StockItem>(`/api/stock/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  listMovements(q?: string) {
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    return request<StockMovementWithItem[]>(`/api/stock/movements${qs}`);
  },

  verifyAdminSettings(password: string) {
    return request<TelegramSettings>('/api/settings/verify', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },

  updateTelegramSettings(payload: {
    password: string;
    telegram_chat_id: string;
    telegram_bot_token?: string;
  }) {
    return request<TelegramSettings>('/api/settings/telegram', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  testTelegramSettings(payload: {
    password: string;
    telegram_chat_id?: string;
    telegram_bot_token?: string;
  }) {
    return request<{ ok: boolean; message: string }>('/api/settings/telegram/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};
