/**
 * Shared state and helpers for the aiImportRoutes routes.
 *
 * Extracted verbatim from the former single-file aiImportRoutes.ts.
 */
import { db } from "../../db";
import { aiCorrectionMemory, suppliers, ledgerAccounts } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { parseMoneyInput, toMoney } from "../../lib/money";
import {
  validateCustomerRows,
  validateStockItemRows,
  type MappedSupplier,
  type MappedVoucher,
  type RawImportRow,
} from "./_helpersValidateStockItemRows";
export { postRows, postStockItemRows, postCustomerRows, postSupplierRows } from "./_helpersHelpers";
export {
  assertJobOwnership,
  upsertCorrection,
  validateCustomerRows,
  validateStockItemRows,
} from "./_helpersValidateStockItemRows";

// ─── Per-type validators ──────────────────────────────────────────────────────

export async function validateRows(
  companyId: number,
  importType: string,
  rows: { id: number; rowNumber: number; rawData: unknown }[]
): Promise<
  {
    id: number;
    status: "valid" | "warning" | "error";
    mappedData: unknown;
    errors: string[];
    warnings: string[];
  }[]
> {
  switch (importType) {
    case "stock_items":
      return validateStockItemRows(companyId, rows);
    case "customers":
      return validateCustomerRows(companyId, rows);
    case "suppliers":
      return validateSupplierRows(companyId, rows);
    case "vouchers":
      return validateVoucherRows(companyId, rows);
    default:
      return validateGenericRows(rows);
  }
}

export async function validateSupplierRows(
  companyId: number,
  rows: { id: number; rowNumber: number; rawData: unknown }[]
) {
  const existingCodes = await db.select({ code: suppliers.code }).from(suppliers).where(isNull(suppliers.deletedAt));
  const existingCodeSet = new Set(existingCodes.map((r) => (r.code || "").toLowerCase()));
  const batchCodes = new Set<string>();

  return rows.map((row) => {
    const raw = row.rawData as RawImportRow;
    const errors: string[] = [];
    const warnings: string[] = [];
    const mapped = {} as MappedSupplier;

    const legalName = String(raw.legalName ?? raw["Legal Name"] ?? raw.name ?? raw.Name ?? "").trim();
    if (!legalName) errors.push("legalName is required");
    mapped.legalName = legalName;

    const code = String(raw.code ?? raw.Code ?? "").trim();
    if (code) {
      const lower = code.toLowerCase();
      if (existingCodeSet.has(lower)) errors.push(`code "${code}" already exists`);
      else if (batchCodes.has(lower)) errors.push(`code "${code}" duplicated within this import`);
      else batchCodes.add(lower);
    }
    mapped.code = code || null;
    mapped.phone = String(raw.phone ?? raw.Phone ?? "").trim() || null;
    mapped.email = String(raw.email ?? raw.Email ?? "").trim() || null;
    mapped.openingBalance = String(toMoney(String(raw.openingBalance ?? raw["Opening Balance"] ?? "")).toNumber());

    const status: "valid" | "warning" | "error" =
      errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid";
    return { id: row.id, status, mappedData: mapped, errors, warnings };
  });
}

export async function validateVoucherRows(
  companyId: number,
  rows: { id: number; rowNumber: number; rawData: unknown }[]
) {
  const [accounts, ledgerCorrections] = await Promise.all([
    db
      .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(
        and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.active, true), isNull(ledgerAccounts.deletedAt))
      ),
    db
      .select()
      .from(aiCorrectionMemory)
      .where(
        and(
          eq(aiCorrectionMemory.companyId, companyId),
          eq(aiCorrectionMemory.memoryType, "ledger_alias"),
          sql`${aiCorrectionMemory.confidence} >= 100`
        )
      ),
  ]);
  const acctByCode = new Map(accounts.map((a) => [a.code?.toLowerCase() ?? "", a]));
  const acctByName = new Map(accounts.map((a) => [a.name?.toLowerCase() ?? "", a]));
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  // rawValue.toLowerCase() → correction (exact remembered ledger-account aliases)
  const ledgerCorrMap = new Map(ledgerCorrections.map((c) => [c.rawValue.toLowerCase(), c]));

  return rows.map((row) => {
    const raw = row.rawData as RawImportRow;
    const errors: string[] = [];
    const warnings: string[] = [];
    const mapped = {} as MappedVoucher;

    // date
    const rawDate = String(raw.date ?? raw.Date ?? raw["Voucher Date"] ?? "").trim();
    if (!rawDate) errors.push("date is required");
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) errors.push(`date "${rawDate}" must be YYYY-MM-DD`);
    mapped.voucherDate = rawDate;

    // type
    const voucherType = String(raw.type ?? raw.Type ?? raw["Voucher Type"] ?? "").trim();
    if (!["Payment", "Receipt", "Journal"].includes(voucherType))
      errors.push(`type must be Payment, Receipt, or Journal — got "${voucherType}"`);
    mapped.voucherType = voucherType;

    mapped.description = String(raw.description ?? raw.Description ?? raw.narration ?? "").trim();

    // debit/credit accounts
    const debitRef = String(raw.debitAccount ?? raw["Debit Account"] ?? "").trim();
    const creditRef = String(raw.creditAccount ?? raw["Credit Account"] ?? "").trim();

    if (!debitRef) errors.push("debitAccount is required");
    if (!creditRef) errors.push("creditAccount is required");

    // Resolve debit account — correction memory wins over name/code lookup
    function resolveAccount(ref: string): { id: number; name: string } | null {
      if (!ref) return null;
      const lo = ref.toLowerCase();
      const corr = ledgerCorrMap.get(lo);
      if (corr?.resolvedId != null) {
        return acctById.get(corr.resolvedId) ?? { id: corr.resolvedId, name: corr.resolvedValue ?? ref };
      }
      return acctByCode.get(lo) ?? acctByName.get(lo) ?? null;
    }

    const debitAcct = debitRef ? resolveAccount(debitRef) : null;
    const creditAcct = creditRef ? resolveAccount(creditRef) : null;

    if (debitRef && !debitAcct) errors.push(`debit account "${debitRef}" not found`);
    if (creditRef && !creditAcct) errors.push(`credit account "${creditRef}" not found`);

    mapped.debitAccountId = debitAcct?.id ?? null;
    mapped.creditAccountId = creditAcct?.id ?? null;

    const amount = parseMoneyInput(String(raw.amount ?? raw.Amount ?? 0))?.toNumber() ?? NaN;
    if (isNaN(amount) || amount <= 0) errors.push("amount must be a positive number");
    mapped.amount = isNaN(amount) ? "0" : amount.toFixed(2);

    const status: "valid" | "warning" | "error" =
      errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid";
    return { id: row.id, status, mappedData: mapped, errors, warnings };
  });
}

export function validateGenericRows(rows: { id: number; rowNumber: number; rawData: unknown }[]) {
  return rows.map((row) => ({
    id: row.id,
    status: "valid" as const,
    mappedData: row.rawData,
    errors: [] as string[],
    warnings: ["importType not recognized — no validation applied"] as string[],
  }));
}

// ─── Per-type posters ─────────────────────────────────────────────────────────

// ─── Route registration ───────────────────────────────────────────────────────
