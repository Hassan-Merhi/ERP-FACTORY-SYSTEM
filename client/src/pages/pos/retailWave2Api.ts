/**
 * Retail Wave 2 API client — one place for every customer / pricing / tax / stock-count call
 * the POS and retail workspace make, so components stay free of fetch plumbing.
 */
import { apiRequest } from "@/lib/queryClient";
import type {
  RetailCartPreview,
  RetailCustomerHistory,
  RetailCustomerSummary,
  RetailDiscountApprovalResponse,
  RetailPromotion,
  RetailSellingSettings,
  RetailStockCountReport,
  RetailStockCountSession,
  RetailStockCountVarianceReport,
} from "./retailWave2Types";
import type { RetailSale } from "./retailPosTypes";

export interface CartRequestLine {
  variantId: number;
  quantity: number;
  priceOverride?: number | null;
  discountType?: "none" | "percent" | "fixed";
  discountValue?: number;
  discountReason?: string | null;
}

export interface CartRequestOrderDiscount {
  type: "none" | "percent" | "fixed";
  value?: number;
  reason?: string | null;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function fetchRetailCartPreview(
  items: CartRequestLine[],
  orderDiscount: CartRequestOrderDiscount | null,
  locationId?: number
): Promise<RetailCartPreview> {
  const response = await apiRequest("POST", "/api/pos/retail/cart-preview", {
    locationId,
    items,
    orderDiscount: orderDiscount ?? undefined,
  });
  return json<RetailCartPreview>(response);
}

export async function requestRetailDiscountApproval(input: {
  managerUsername: string;
  managerPassword: string;
  reason?: string;
  items: CartRequestLine[];
  orderDiscount: CartRequestOrderDiscount | null;
}): Promise<RetailDiscountApprovalResponse> {
  const response = await apiRequest("POST", "/api/pos/retail/discount-approvals", {
    managerUsername: input.managerUsername,
    managerPassword: input.managerPassword,
    reason: input.reason,
    items: input.items,
    orderDiscount: input.orderDiscount ?? undefined,
  });
  return json<RetailDiscountApprovalResponse>(response);
}

export async function fetchRetailSellingSettings(): Promise<RetailSellingSettings> {
  const response = await apiRequest("GET", "/api/pos/retail/settings");
  return json<RetailSellingSettings>(response);
}

export async function saveRetailSellingSettings(patch: Partial<RetailSellingSettings>): Promise<RetailSellingSettings> {
  const response = await apiRequest("PUT", "/api/pos/retail/settings", patch);
  return json<RetailSellingSettings>(response);
}

export async function searchRetailCustomers(search: string, limit = 20): Promise<RetailCustomerSummary[]> {
  const response = await apiRequest(
    "GET",
    `/api/pos/retail/customers?search=${encodeURIComponent(search)}&limit=${limit}`
  );
  return json<RetailCustomerSummary[]>(response);
}

export async function createRetailCustomer(input: {
  legalName: string;
  phone?: string;
}): Promise<RetailCustomerSummary> {
  const response = await apiRequest("POST", "/api/pos/retail/customers", input);
  return json<RetailCustomerSummary>(response);
}

export async function fetchRetailCustomerHistory(customerId: number, limit = 25): Promise<RetailCustomerHistory> {
  const response = await apiRequest("GET", `/api/pos/retail/customers/${customerId}/history?limit=${limit}`);
  return json<RetailCustomerHistory>(response);
}

export async function searchRetailSalesHistory(params: {
  receipt?: string;
  customerId?: number;
  barcode?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  locationId?: number;
  limit?: number;
}): Promise<RetailSale[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") query.set(key, String(value));
  }
  const response = await apiRequest("GET", `/api/pos/retail/sales/search?${query.toString()}`);
  return json<RetailSale[]>(response);
}

export async function listRetailPromotions(): Promise<RetailPromotion[]> {
  const response = await apiRequest("GET", "/api/retail/promotions");
  return json<RetailPromotion[]>(response);
}

export async function createRetailPromotion(input: {
  name: string;
  discountType: "percent" | "fixed";
  value: number;
  startsAt?: string | null;
  endsAt?: string | null;
  brandId?: number | null;
  productId?: number | null;
  variantId?: number | null;
  active?: boolean;
}): Promise<RetailPromotion> {
  const response = await apiRequest("POST", "/api/retail/promotions", input);
  return json<RetailPromotion>(response);
}

export async function deactivateRetailPromotion(id: number): Promise<RetailPromotion> {
  const response = await apiRequest("DELETE", `/api/retail/promotions/${id}`);
  return json<RetailPromotion>(response);
}

export async function listRetailStockCountSessions(
  params: {
    locationId?: number;
    status?: string;
    limit?: number;
  } = {}
): Promise<RetailStockCountSession[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") query.set(key, String(value));
  }
  const response = await apiRequest("GET", `/api/pos/retail/stock-counts?${query.toString()}`);
  return json<RetailStockCountSession[]>(response);
}

export async function createRetailStockCountSession(input: {
  locationId: number;
  notes?: string | null;
  includeAllVariants?: boolean;
  startNow?: boolean;
}): Promise<RetailStockCountSession> {
  const response = await apiRequest("POST", "/api/pos/retail/stock-counts", input);
  return json<RetailStockCountSession>(response);
}

export async function fetchRetailStockCountSession(id: number): Promise<RetailStockCountSession> {
  const response = await apiRequest("GET", `/api/pos/retail/stock-counts/${id}`);
  return json<RetailStockCountSession>(response);
}

export async function scanRetailStockCount(
  id: number,
  input: { barcode?: string; variantId?: number; quantity?: number; mode?: "increment" | "set"; note?: string | null }
): Promise<{ session: RetailStockCountSession }> {
  const response = await apiRequest("POST", `/api/pos/retail/stock-counts/${id}/scan`, input);
  return json<{ session: RetailStockCountSession }>(response);
}

export async function updateRetailStockCountLine(
  sessionId: number,
  lineId: number,
  patch: { countedQuantity?: number; recountRequired?: boolean; notes?: string | null }
): Promise<RetailStockCountSession> {
  const response = await apiRequest("PATCH", `/api/pos/retail/stock-counts/${sessionId}/lines/${lineId}`, patch);
  return json<RetailStockCountSession>(response);
}

export async function transitionRetailStockCount(
  id: number,
  action: "start" | "review" | "recount" | "finalize" | "cancel",
  body: Record<string, unknown> = {}
): Promise<{ session: RetailStockCountSession }> {
  const response = await apiRequest("POST", `/api/pos/retail/stock-counts/${id}/${action}`, body);
  return json<{ session: RetailStockCountSession }>(response);
}

export async function fetchRetailStockCountVariance(id: number): Promise<RetailStockCountVarianceReport> {
  const response = await apiRequest("GET", `/api/pos/retail/stock-counts/${id}/variance`);
  return json<RetailStockCountVarianceReport>(response);
}

export async function fetchRetailStockCountReport(
  params: {
    locationId?: number;
    status?: string;
  } = {}
): Promise<RetailStockCountReport> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") query.set(key, String(value));
  }
  const response = await apiRequest("GET", `/api/pos/retail/stock-counts/report?${query.toString()}`);
  return json<RetailStockCountReport>(response);
}

/** CSV export URL for the stock-count history (server renders the file). */
export function retailStockCountReportCsvUrl(locationId?: number): string {
  const query = new URLSearchParams({ format: "csv" });
  if (locationId) query.set("locationId", String(locationId));
  return `/api/pos/retail/stock-counts/report?${query.toString()}`;
}
