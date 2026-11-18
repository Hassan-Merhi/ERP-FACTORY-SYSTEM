// Extracted from ./useIntercompanyLifecycleContentState.ts

export const API = "/api/intercompany-container-trading/lifecycle";

export const newKey = () =>
  "ic-phase5-" +
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));

export const dateNow = () => new Date().toLocaleDateString("en-CA");

export const money = (value: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value));

type Trade = {
  tradeId: number;
  physicalContainerId: number;
  relationshipId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  version: number;
  state: string;
  containerNumber: string;
  physicalStatus: string;
  landedCost: string;
  received: null | { id: number; date: string; locationId: number; voucherId: number };
  canceled: null | { id: number; date: string; releasedCredit: string };
  hasSharedInvoices: boolean;
  pendingSharedAllocation: boolean;
  accountingNetted: boolean;
};

type Lifecycle = {
  trades: Trade[];
  locations: Array<{ id: number; name: string }>;
  inventoryAccounts: Array<{ id: number; name: string }>;
};

export async function load(companyId: number): Promise<Lifecycle> {
  if (!companyId) throw new Error("Select a company");
  const response = await fetch(API, { credentials: "include" });
  const value = await response.json().catch(() => ({ message: "Cannot read intercompany lifecycle" }));
  if (!response.ok) throw new Error(value.message || "Cannot read intercompany lifecycle");
  return value as Lifecycle;
}
