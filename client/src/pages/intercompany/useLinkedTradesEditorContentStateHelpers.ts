// Extracted from ./useLinkedTradesEditorContentState.ts

export const BASE = "/api/intercompany-container-trading";

export interface TradeRow {
  tradeId: number;
  physicalContainerId: number;
  version: number;
  containerNumber: string;
  landedCost: string | null;
  sourceCompanyId: number;
  destinationCompanyId: number;
  destinationPoId: number | null;
}

interface TradeLine {
  lineLinkId: number;
  sourcePoNumber: string;
  quantity: string;
  rate: string;
  lineTotal: string;
  itemName: string;
  sourceLineId: number;
  destinationLineId: number;
}

export interface TradeDetail {
  tradeId: number;
  version: number;
  containerNumber: string;
  physicalStatus: string;
  landedCost: string;
  goodsCost: string;
  lines: TradeLine[];
}

export interface AllocationPreview {
  faceAmount: string;
  allocations: Array<{ tradeId: number; containerNumber: string; expectedVersion: number; suggestedAmount: string }>;
}

export interface InvoiceDetail {
  invoiceId: number;
  externalInvoiceKey: string;
  chargeType: string;
  faceAmount: string;
  evidenceReference: string;
  version: number;
  allocations: Array<{
    tradeId: number;
    containerNumber: string;
    amount: string;
    expectedVersion: number;
    relationshipId: number;
    sourceCompanyId: number;
    destinationCompanyId: number;
  }>;
}

export type EditableLine = Pick<TradeLine, "lineLinkId" | "quantity" | "rate" | "itemName">;

export function today() {
  return new Date().toLocaleDateString("en-CA");
}

export function key() {
  return "ic-ui-" + crypto.randomUUID();
}

export async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...options });
  const payload = await response.json().catch(() => ({ message: "Request failed" }));
  if (!response.ok) throw new Error(payload.message ?? "Request failed");
  return payload as T;
}

export const toCents = (value: string) => Math.round(Number(value || 0) * 100);
