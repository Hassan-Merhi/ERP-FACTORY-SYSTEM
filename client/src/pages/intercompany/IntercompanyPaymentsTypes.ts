// Extracted from ./IntercompanyPayments.tsx to keep that module under the source-size cap.

export const BASE = "/api/intercompany-container-trading/payments";

export const newKey = () => {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
  return "icpay-" + id;
};

export const dateNow = () => new Date().toLocaleDateString("en-CA");

export const money = (s: string | number | null) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(s || 0));

export type Pair = {
  relationshipId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  tradeEnabled: boolean;
};

type CashRef = { type: "bank" | "cash"; id: number };

type CashAccount = CashRef & { companyId: number; name: string };

type UnpaidPO = {
  tradeId: number;
  version: number;
  containerNumber: string;
  landedCost: string;
  applied: string;
  unpaid: string;
};

type Credit = { paymentId: number; available: string; originalPaymentDate: string };

export type Setup = {
  relationshipId: number;
  tradeEnabled: boolean;
  sourceCompanyId: number;
  destinationCompanyId: number;
  cashAccounts: CashAccount[];
  purchaseOrders: UnpaidPO[];
  credits: Credit[];
};

export type HistoryPayment = {
  id: number;
  status: "confirmed" | "reversed";
  paymentDate: string;
  transferReference: string;
  currency: string;
  nativeAmount: string;
  historicalRate: string;
  baseAmount: string;
  credit: string;
  sourceVoucherId: number;
  destinationVoucherId: number;
  sourceReversalVoucherId: number | null;
  destinationReversalVoucherId: number | null;
  applied: Array<{ tradeId: number; amount: string }>;
};

export const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { credentials: "include" });
  const value = await response.json().catch(() => ({ message: "Could not read payment data" }));
  if (!response.ok) throw new Error(value.message || "Could not load payment details");
  return value as T;
};

export const parseCash = (value: string): CashRef => {
  const [type, id] = value.split(":");
  if ((type !== "bank" && type !== "cash") || !id || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new Error("Choose an active cash or bank account");
  }
  return { type, id: Number(id) };
};
