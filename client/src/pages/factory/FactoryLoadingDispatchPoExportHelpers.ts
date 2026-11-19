// Extracted from ./FactoryLoadingDispatchPoExport.tsx

interface Article {
  articleCode: string;
  itemName: string;
  quantity: number;
  totalKg: string;
  factoryGoodsValue: string;
  distinctFactoryNames: string[];
}

export interface Charges {
  freight: string;
  surcharge: string;
  fumigation: string;
  discount: string;
  documentCharges: string;
}

type ChargeKey = keyof Charges;

interface SavedExport {
  id: number;
  exportedAt: string;
  exportFingerprint: string;
  supplierCode: string;
  poNumber: string;
  containerNumber: string;
  preview: {
    rates?: Array<{ articleCode: string; rate: string }>;
    charges?: Charges;
  };
}

export interface Setup {
  status: string;
  revision: number;
  sourceFingerprint: string;
  factoryCustomerTotal: string;
  factoryGoodsSubtotal: string;
  poNumber: string;
  containerNumber: string;
  articles: Article[];
  suggested: {
    charges: Charges;
    unmappedBillableCharges: Array<{ id: number; name: string; amount: string }>;
    internalExpenseTotal: string;
  };
  previousExport: SavedExport | null;
  importInstructions: string;
}

export interface Preview {
  exportFingerprint: string;
  sourceFingerprint: string;
  revision: number;
  poNumber: string;
  containerNumber: string;
  supplierCode: string;
  goodsTotal: string;
  chargesTotal: string;
  supplierInvoiceTotal: string;
  factoryCustomerTotal: string;
  rowCount: number;
  alreadyGenerated: boolean;
}

export interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: string;
  role: string;
}

export const emptyCharges = (): Charges => ({
  freight: "0.00",
  surcharge: "0.00",
  fumigation: "0.00",
  discount: "0.00",
  documentCharges: "0.00",
});

export const chargeFields: Array<{ key: ChargeKey; label: string }> = [
  { key: "freight", label: "Freight" },
  { key: "surcharge", label: "Surcharge" },
  { key: "fumigation", label: "Fumigation" },
  { key: "discount", label: "Discount" },
  { key: "documentCharges", label: "Document charges" },
];

export const money = (value: string | undefined) => {
  const v = Number(value ?? "");
  return Number.isFinite(v) ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
};

export const isMoney = (v: string, positive = false) =>
  /^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(v.trim()) && Number.isFinite(Number(v)) && (!positive || Number(v) > 0);

export const canExport = (role: string) => ["admin", "owner", "developer"].includes(role.toLowerCase());

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Could not export PO file");

export async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Unable to read posted trip");
  return body as T;
}
