// Extracted from ./sharedFactoryAccessBoundary.ts
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { vouchers } from "@shared/schema";
import {
  authorizeFactoryPageAccess,
  authorizeFactoryTabAccess,
  getFactoryAccessState,
  type FactoryAccessDecision,
} from "../lib/factoryAccessControl";

export type SharedFactoryRequirement = {
  pageKey: string;
  tabKey?: string;
};

export function page(pageKey: string, tabKey?: string): SharedFactoryRequirement {
  return { pageKey, ...(tabKey ? { tabKey } : {}) };
}

export const VOUCHERS_PAGE = "factory/vouchers";

export const ACCOUNTS_PAGE = "factory/accounts";

export const DAYBOOK_PAGE = "factory/daybook";

export const VOUCHER_TABS = {
  payment: "hide_tab_vouchers_payment",
  receipt: "hide_tab_vouchers_receipt",
  journal: "hide_tab_vouchers_journal",
  transfer: "hide_tab_vouchers_transfer",
  transferOrder: "hide_tab_vouchers_transferorder",
  adjustment: "hide_tab_vouchers_adjustment",
  creditNote: "hide_tab_vouchers_creditnote",
} as const;

export function voucherRequirementsForType(voucherType: unknown): SharedFactoryRequirement[] {
  const value = String(voucherType ?? "")
    .trim()
    .toLowerCase();
  if (value === "payment") return [page(VOUCHERS_PAGE, VOUCHER_TABS.payment)];
  if (value === "receipt") return [page(VOUCHERS_PAGE, VOUCHER_TABS.receipt)];
  if (value === "journal" || value === "contra") return [page(VOUCHERS_PAGE, VOUCHER_TABS.journal)];
  if (value === "stock transfer" || value === "stocktransfer" || value === "transfer") {
    return [page(VOUCHERS_PAGE, VOUCHER_TABS.transfer), page(VOUCHERS_PAGE, VOUCHER_TABS.transferOrder)];
  }
  if (value === "stock adjustment" || value === "production" || value === "consumption" || value === "mixed") {
    return [page(VOUCHERS_PAGE, VOUCHER_TABS.adjustment)];
  }
  if (value === "credit note" || value === "debit note") {
    return [page(VOUCHERS_PAGE, VOUCHER_TABS.creditNote)];
  }
  return [page(VOUCHERS_PAGE)];
}

export async function existingVoucherRequirements(
  req: Request,
  voucherId: number
): Promise<SharedFactoryRequirement[]> {
  const state = await getFactoryAccessState(req);
  if (!state) return [page(VOUCHERS_PAGE)];

  const [row] = await db
    .select({ voucherType: vouchers.voucherType })
    .from(vouchers)
    .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, state.companyId)))
    .limit(1);

  return row ? voucherRequirementsForType(row.voucherType) : [page(VOUCHERS_PAGE)];
}

export function ownerMismatch(): Exclude<FactoryAccessDecision, { allowed: true }> {
  return {
    allowed: false,
    code: "FACTORY_PAGE_ACCESS_DENIED",
    message: "This shared API is not owned by the current Factory page.",
  };
}

export async function evaluateRequirement(
  req: Request,
  rule: SharedFactoryRequirement
): Promise<FactoryAccessDecision> {
  return rule.tabKey
    ? authorizeFactoryTabAccess(req, rule.pageKey, rule.tabKey)
    : authorizeFactoryPageAccess(req, rule.pageKey);
}
