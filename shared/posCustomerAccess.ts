/**
 * POS customer capabilities are per-user, per-active-company.
 * A cached browser/session flag never grants server access.
 */
export interface PosCustomerAccessFlags {
  role: string;
  canAccessCustomers: boolean;
  posViewOnly?: boolean;
  developerBypass?: boolean;
}

export const posCustomerAccessText = {
  switchTitle: "Allow Customers",
  switchHelp: "Let this POS user view customer accounts and create new customers. Opening balances remain restricted.",
  denied: "Access denied: customer access is not enabled for this company.",
  createDenied: "Access denied: this account cannot create customers.",
  openingDenied: "POS users cannot assign opening balances when creating customers.",
  ledgerDenied: "POS users cannot link a customer to an existing ledger account.",
  summary: "View and create customers",
} as const;

export function canViewPosCustomers(flags: PosCustomerAccessFlags): boolean {
  return flags.developerBypass === true || flags.canAccessCustomers === true;
}

export function canCreatePosCustomers(flags: PosCustomerAccessFlags): boolean {
  return (
    canViewPosCustomers(flags) &&
    flags.role !== "View Only" &&
    flags.role !== "Create Only" &&
    !(flags.role === "POS" && flags.posViewOnly === true)
  );
}

export function hasZeroOpeningBalance(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "number" && typeof value !== "string") return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount === 0;
}
