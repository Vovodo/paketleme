export type StockStatus = 'IN_STOCK' | 'REQUESTED' | 'CONSUMED';

export interface StockMovement {
  id: number;
  stock_item_id: number;
  action: string;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  note?: string | null;
  created_at: string;
}

export interface StockMovementWithItem extends StockMovement {
  label_code: string;
  reference: string;
  level: string;
}

export interface StockItem {
  id: number;
  label_code: string;
  qr_payload: string;
  reference: string;
  level: string;
  initial_quantity: number;
  remaining_quantity: number;
  status: StockStatus;
  location_note?: string | null;
  created_by?: string | null;
  requested_at?: string | null;
  requested_note?: string | null;
  consumed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseRequestResponse {
  item: StockItem;
  telegram_sent: boolean;
  telegram_error?: string | null;
}

export interface StockItemDetail extends StockItem {
  movements: StockMovement[];
}

export interface ReferenceLevelGroup {
  reference: string;
  level: string;
  total_quantity: number;
  label_count: number;
  requested_count: number;
  requested_quantity: number;
  oldest_created_at: string;
}

export interface StockDashboardSummary {
  active_label_count: number;
  active_total_quantity: number;
  distinct_reference_count: number;
  requested_label_count: number;
  requested_total_quantity: number;
  consumed_today_count: number;
  consumed_today_quantity: number;
  groups: ReferenceLevelGroup[];
}

export interface StockDashboardViewData {
  summary: StockDashboardSummary;
  items: StockItem[];
}

export interface ProductionMatchItem {
  reference: string;
  level?: string;
}

export interface ProductionMatchResult {
  query_reference: string;
  query_level?: string | null;
  exact_level_matches: StockItem[];
  other_level_matches: StockItem[];
  total_exact_quantity: number;
  total_other_quantity: number;
}

export interface Suggestions {
  references: string[];
  levels: string[];
}

export interface TelegramSettings {
  telegram_chat_id: string;
  has_bot_token: boolean;
  masked_bot_token: string;
}

export type PaperFormat = 'a4-landscape' | 'a5-landscape' | 'thermal-150x100';
