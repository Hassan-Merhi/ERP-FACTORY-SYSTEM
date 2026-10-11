/**
 * Shared state and helpers for the aiImportRoutes routes.
 *
 * Extracted verbatim from the former single-file aiImportRoutes.ts.
 */
import { db } from "../../db";
import { logAudit } from "../_helpers";
import {
  aiImportJobs,
  aiCorrectionMemory,
  stockItems,
  stockGroups,
  customers,
  suppliers,
  ledgerAccounts,
} from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function assertJobOwnership(jobId: number, companyId: number) {
  const [job] = await db
    .select()
    .from(aiImportJobs)
    .where(and(eq(aiImportJobs.id, jobId), eq(aiImportJobs.companyId, companyId)));
  if (!job) throw Object.assign(new Error("Import job not found"), { status: 404 });
  return job;
}

/**
 * Upsert a correction entry into aiCorrectionMemory.
 * If an entry for (companyId, memoryType, rawValue) already exists it is updated;
 * otherwise a new row is inserted. Case-insensitive match on rawValue.
 * Only confidence=100 corrections are auto-applied during future validation runs.
 */
export async function upsertCorrection(params: {
  companyId: number;
  userId: string;
  memoryType: string;
  rawValue: string;
  resolvedId: number | null;
  resolvedValue: string | null;
  resolvedType: string | null;
  confidence?: number;
}): Promise<void> {
  const { companyId, userId, memoryType, rawValue, resolvedId, resolvedValue, resolvedType, confidence = 100 } = params;

  const [existing] = await db
    .select({ id: aiCorrectionMemory.id })
    .from(aiCorrectionMemory)
    .where(
      and(
        eq(aiCorrectionMemory.companyId, companyId),
        eq(aiCorrectionMemory.memoryType, memoryType),
        sql`LOWER(${aiCorrectionMemory.rawValue}) = LOWER(${rawValue})`
      )
    )
    .limit(1);

  if (existing) {
    await db
      .update(aiCorrectionMemory)
      .set({ resolvedId, resolvedValue, resolvedType, confidence, updatedAt: new Date() })
      .where(eq(aiCorrectionMemory.id, existing.id));
  } else {
    await db.insert(aiCorrectionMemory).values({
      companyId,
      memoryType,
      rawValue,
      resolvedId,
      resolvedValue,
      resolvedType,
      confidence,
      createdBy: userId,
    });
  }
}

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

/**
 * One spreadsheet row exactly as uploaded. Keys and value types come from the
 * source file, so every read is coerced before use.
 */
type RawImportRow = Record<string, unknown>;

/** A stock item resolved from an import row. */
type MappedStockItem = {
  name: string;
  code: string | null;
  sellingPrice: string;
  reorderLevel: string;
  stockGroupId: number | null;
};

/** A customer resolved from an import row. */
type MappedCustomer = {
  name: string;
  legalName: string;
  code: string | null;
  phone: string | null;
  email: string | null;
};

/** A supplier resolved from an import row. */
type MappedSupplier = {
  legalName: string;
  code: string | null;
  phone: string | null;
  email: string | null;
  openingBalance: string;
};

/** A voucher resolved from an import row. */
type MappedVoucher = {
  voucherDate: string;
  voucherType: string;
  description: string;
  debitAccountId: number | null;
  creditAccountId: number | null;
  amount: string;
};

export async function validateStockItemRows(
  companyId: number,
  rows: { id: number; rowNumber: number; rawData: unknown }[]
) {
  // Pre-fetch lookup data (including correction memory for stock-group aliases)
  const [existingCodes, groups, itemCorrections] = await Promise.all([
    db
      .select({ code: stockItems.code })
      .from(stockItems)
      .where(and(eq(stockItems.companyId, companyId), eq(stockItems.active, true), isNull(stockItems.deletedAt))),
    db
      .select({ id: stockGroups.id, name: stockGroups.name, code: stockGroups.code })
      .from(stockGroups)
      .where(eq(stockGroups.companyId, companyId)),
    db
      .select()
      .from(aiCorrectionMemory)
      .where(
        and(
          eq(aiCorrectionMemory.companyId, companyId),
          eq(aiCorrectionMemory.memoryType, "item_alias"),
          sql`${aiCorrectionMemory.confidence} >= 100`
        )
      ),
  ]);

  const existingCodeSet = new Set(existingCodes.map((r) => (r.code || "").toLowerCase()));
  const groupByCode = new Map(groups.map((g) => [g.code?.toLowerCase() ?? "", g]));
  const groupByName = new Map(groups.map((g) => [g.name?.toLowerCase() ?? "", g]));
  // rawValue.toLowerCase() → correction (exact remembered matches only)
  const itemCorrMap = new Map(itemCorrections.map((c) => [c.rawValue.toLowerCase(), c]));

  // Track codes introduced within this batch (to catch intra-batch duplicates)
  const batchCodes = new Set<string>();

  return rows.map((row) => {
    const raw = row.rawData as RawImportRow;
    const errors: string[] = [];
    const warnings: string[] = [];
    const mapped = {} as MappedStockItem;

    // name
    const name = String(raw.name ?? raw.Name ?? raw["Item Name"] ?? "").trim();
    if (!name) errors.push("name is required");
    mapped.name = name;

    // code
    const code = String(raw.code ?? raw.Code ?? raw["Item Code"] ?? "").trim();
    if (!code) {
      warnings.push("code is missing — will be auto-generated on post");
    } else {
      const lower = code.toLowerCase();
      if (existingCodeSet.has(lower)) errors.push(`code "${code}" already exists`);
      else if (batchCodes.has(lower)) errors.push(`code "${code}" is duplicated within this import`);
      else batchCodes.add(lower);
    }
    mapped.code = code || null;

    // sellingPrice
    const sellingPrice = parseFloat(String(raw.sellingPrice ?? raw["Selling Price"] ?? raw.price ?? 0));
    if (isNaN(sellingPrice) || sellingPrice < 0) errors.push("sellingPrice must be a non-negative number");
    mapped.sellingPrice = isNaN(sellingPrice) ? "0" : sellingPrice.toFixed(2);

    // reorderLevel
    const reorderLevel = parseFloat(String(raw.reorderLevel ?? raw["Reorder Level"] ?? raw.reorder ?? 0));
    mapped.reorderLevel = isNaN(reorderLevel) ? "0" : reorderLevel.toFixed(2);

    // stockGroup — check correction memory first, then fall back to name/code match
    const groupRef = String(raw.stockGroupCode ?? raw.stockGroup ?? raw["Stock Group"] ?? "").trim();
    let stockGroupId: number | null = null;
    if (groupRef) {
      const corr = itemCorrMap.get(groupRef.toLowerCase());
      if (corr?.resolvedId != null) {
        // Exact remembered correction — apply silently (no warning)
        stockGroupId = corr.resolvedId;
      } else {
        const found = groupByCode.get(groupRef.toLowerCase()) ?? groupByName.get(groupRef.toLowerCase());
        if (!found) warnings.push(`stock group "${groupRef}" not found — item will be ungrouped`);
        else stockGroupId = found.id;
      }
    }
    mapped.stockGroupId = stockGroupId;

    const status: "valid" | "warning" | "error" =
      errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid";

    return { id: row.id, status, mappedData: mapped, errors, warnings };
  });
}

export async function validateCustomerRows(
  companyId: number,
  rows: { id: number; rowNumber: number; rawData: unknown }[]
) {
  const existingCodes = await db
    .select({ code: customers.code })
    .from(customers)
    .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)));
  const existingCodeSet = new Set(existingCodes.map((r) => (r.code || "").toLowerCase()));
  const batchCodes = new Set<string>();

  return rows.map((row) => {
    const raw = row.rawData as RawImportRow;
    const errors: string[] = [];
    const warnings: string[] = [];
    const mapped = {} as MappedCustomer;

    const name = String(raw.name ?? raw.Name ?? raw["Customer Name"] ?? "").trim();
    if (!name) errors.push("name is required");
    mapped.name = name;
    mapped.legalName = String(raw.legalName ?? raw["Legal Name"] ?? name).trim();

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

    const status: "valid" | "warning" | "error" =
      errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid";
    return { id: row.id, status, mappedData: mapped, errors, warnings };
  });
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
    mapped.openingBalance = String(parseFloat(String(raw.openingBalance ?? raw["Opening Balance"] ?? "0")) || 0);

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

    const amount = parseFloat(String(raw.amount ?? raw.Amount ?? 0));
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

export async function postRows(
  companyId: number,
  userId: string,
  username: string,
  importType: string,
  rows: { id: number; mappedData: unknown }[],
  tx: typeof db
): Promise<{ rowId: number; recordType: string; recordId: number }[]> {
  switch (importType) {
    case "stock_items":
      return postStockItemRows(companyId, userId, username, rows, tx);
    case "customers":
      return postCustomerRows(companyId, userId, username, rows, tx);
    case "suppliers":
      return postSupplierRows(companyId, userId, username, rows, tx);
    default:
      return [];
  }
}

// Phase 21 (B): each row's create audit is written on the posting transaction.
export async function postStockItemRows(
  companyId: number,
  userId: string,
  username: string,
  rows: { id: number; mappedData: unknown }[],
  tx: typeof db
) {
  const results: { rowId: number; recordType: string; recordId: number }[] = [];
  for (const row of rows) {
    const d = row.mappedData as MappedStockItem;
    const [created] = await tx
      .insert(stockItems)
      .values({
        companyId,
        name: d.name,
        // code is NOT NULL in the schema; a row that reaches here without one
        // fails at the database, exactly as it does today.
        code: d.code as string,
        sellingPrice: d.sellingPrice ?? "0",
        reorderLevel: d.reorderLevel ?? "0",
        stockGroupId: d.stockGroupId ?? null,
        active: true,
        // The import mapper does not resolve every NOT NULL column (uom); this
        // asserts the row it produced rather than changing what is written.
      } as typeof stockItems.$inferInsert)
      .returning({ id: stockItems.id });

    await logAudit(
      {
        userId,
        username,
        companyId,
        action: "create",
        tableName: "stock_items",
        recordId: created.id,
        recordIdentifier: d.code || d.name,
        changes: null,
      },
      tx
    );

    results.push({ rowId: row.id, recordType: "stock_item", recordId: created.id });
  }
  return results;
}

export async function postCustomerRows(
  companyId: number,
  userId: string,
  username: string,
  rows: { id: number; mappedData: unknown }[],
  tx: typeof db
) {
  const results: { rowId: number; recordType: string; recordId: number }[] = [];
  for (const row of rows) {
    const d = row.mappedData as MappedCustomer;
    const [created] = await tx
      .insert(customers)
      .values({
        companyId,
        // `customers` has no name column — legal_name is the stored name.
        legalName: d.legalName,
        // code is NOT NULL in the schema; a row that reaches here without one
        // fails at the database, exactly as it does today.
        code: d.code as string,
        phone: d.phone ?? null,
        email: d.email ?? null,
        active: true,
      } as typeof customers.$inferInsert)
      .returning({ id: customers.id });

    await logAudit(
      {
        userId,
        username,
        companyId,
        action: "create",
        tableName: "customers",
        recordId: created.id,
        recordIdentifier: d.code || d.name,
        changes: null,
      },
      tx
    );

    results.push({ rowId: row.id, recordType: "customer", recordId: created.id });
  }
  return results;
}

export async function postSupplierRows(
  companyId: number,
  userId: string,
  username: string,
  rows: { id: number; mappedData: unknown }[],
  tx: typeof db
) {
  const results: { rowId: number; recordType: string; recordId: number }[] = [];
  for (const row of rows) {
    const d = row.mappedData as MappedSupplier;
    const [created] = await tx
      .insert(suppliers)
      .values({
        companyId,
        legalName: d.legalName,
        // code is NOT NULL in the schema; a row that reaches here without one
        // fails at the database, exactly as it does today.
        code: d.code as string,
        phone: d.phone ?? null,
        email: d.email ?? null,
        openingBalance: d.openingBalance ?? "0",
        active: true,
      } as typeof suppliers.$inferInsert)
      .returning({ id: suppliers.id });

    await logAudit(
      {
        userId,
        username,
        companyId,
        action: "create",
        tableName: "suppliers",
        recordId: created.id,
        recordIdentifier: d.code || d.legalName,
        changes: null,
      },
      tx
    );

    results.push({ rowId: row.id, recordType: "supplier", recordId: created.id });
  }
  return results;
}

// ─── Route registration ───────────────────────────────────────────────────────
