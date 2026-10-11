import type { Request, Response } from "express";
import { db } from "../../db";
import { sql, eq, and, isNull } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import { firstRow } from "../../lib/queryResult";
import { parseMoneyInput } from "../../lib/money";

// ── Shared SP (Supplier Partner) route helpers ────────────────────────────────
// Structural-only extraction from the former monolithic spRoutes.ts — logic is
// byte-for-byte identical to what every SP route sub-module previously used.

export function getCompanyId(req: import("express").Request): number | null {
  return req.session?.currentCompanyId ?? null;
}

export async function requireSpCompany(req: Request, res: Response): Promise<number | null> {
  const companyId = getCompanyId(req);
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }
  const rows = await db.execute(sql`SELECT company_type FROM companies WHERE id = ${companyId} LIMIT 1`);
  const row = firstRow(rows) ?? (rows as unknown as { [key: string]: Record<string, unknown> | undefined })[0];
  if (!row || row.company_type !== "supplier_partner") {
    res.status(403).json({ message: "Not a supplier_partner company" });
    return null;
  }
  return companyId;
}

export async function getSpAccount(companyId: number, subType: string) {
  const [acct] = await db
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, subType),
        isNull(ledgerAccounts.deletedAt)
      )
    );
  return acct;
}

export function parseNum(v: unknown): number {
  const n = parseMoneyInput(String(v ?? "0"))?.toNumber() ?? NaN;
  return isNaN(n) ? 0 : n;
}

// ── SP Chart of Accounts setup ───────────────────────────────────────────────

export const SP_ACCOUNTS = [
  { code: "SP-OTW", name: "Goods On The Way", accountType: "Asset", subType: "sp_goods_otw", isHidden: false },
  {
    code: "SP-OTWCLR",
    name: "Goods OTW Clearing",
    accountType: "Liability",
    subType: "sp_otw_clearing",
    isHidden: true,
  },
  { code: "SP-PREPAID", name: "Prepaid Charges", accountType: "Asset", subType: "sp_prepaid", isHidden: false },
  // SP-STOCK is isHidden=true: it is an internal double-entry counterpart to the ERP
  // inventory table and must NOT appear as a normal postable account in the Accounts UI.
  { code: "SP-STOCK", name: "Stock on Floor", accountType: "Asset", subType: "sp_stock", isHidden: true },
  {
    code: "SP-COSTCLR",
    name: "Stock Cost Payable Clearing",
    accountType: "Liability",
    subType: "sp_cost_clearing",
    isHidden: true,
  },
  // Internal clearing account to keep vouchers balanced when a per-qty deduction
  // silently reduces Supplier Cash Payable. Not income/expense — excluded from all reports.
  {
    code: "SP-PAYDDC",
    name: "Supplier Payable Deduction Clearing",
    accountType: "Liability",
    subType: "sp_pay_deduction_clearing",
    isHidden: true,
  },
  { code: "SP-PAY", name: "Supplier Cash Payable", accountType: "Liability", subType: "sp_payable", isHidden: false },
  { code: "SP-SALES", name: "Sales", accountType: "Income", subType: "sp_sales", isHidden: false },
  { code: "SP-COGS", name: "Cost of Goods Sold", accountType: "Direct Expense", subType: "sp_cogs", isHidden: false },
  {
    code: "SP-SHARED",
    name: "Shared Charges",
    accountType: "Direct Expense",
    subType: "sp_shared_charges",
    isHidden: false,
  },
  { code: "SP-OPNBAL", name: "Opening Balance Clearing", accountType: "Equity", subType: "sp_opnbal", isHidden: true },
  {
    code: "SP-PREEXP",
    name: "Prepaid Expenses",
    accountType: "Asset",
    subType: "sp_prepaid_expenses",
    isHidden: false,
  },
  {
    code: "SP-HADI-IC",
    name: "HADI L'SHI — Intercompany",
    accountType: "Intercompany",
    subType: "sp_hadi_intercompany",
    isHidden: false,
  },
];
