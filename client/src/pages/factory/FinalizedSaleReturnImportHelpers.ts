// Extracted from ./FinalizedSaleReturnImport.tsx

export type PreviewRow = {
  reference: string;
  status: "matched" | "duplicate" | "missing" | "ambiguous" | "blocked";
  message: string | null;
  baleId?: number;
  orderId?: number;
  invoiceNumber?: string;
  containerNumber?: string | null;
  customerName?: string | null;
  grandTotal?: string;
  articleCode?: string | null;
  productName?: string | null;
};

export type Preview = {
  customerId: number;
  customerName: string;
  rows: PreviewRow[];
  matched: number;
  issues: number;
  note: string;
};

export type CustomerOption = { id: number; legalName: string };

export type Posted = {
  invoiceNumber: string;
  quantity: number;
  customerCredit: string;
  revisedTotal: string;
  warning: string | null;
};

export type InvoiceGroup = {
  orderId: number;
  invoiceNumber: string;
  containerNumber: string | null;
  customerName: string | null;
  grandTotal: string;
  rows: Array<PreviewRow & { baleId: number; orderId: number }>;
};

export type Outcome = { success: boolean; quantity: number; message: string };

export const endpoint = "/api/factory/finalized-sale-returns";

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Unable to load customers");
  return data as T;
}

export async function postJson<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Could not complete the return");
  return data as T;
}
