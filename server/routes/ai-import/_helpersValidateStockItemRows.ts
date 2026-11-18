// Extracted from ./_helpers.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { aiCorrectionMemory, aiImportJobs, customers, stockGroups, stockItems } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { parseMoneyInput } from "../../lib/money";

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

/**
 * One spreadsheet row exactly as uploaded. Keys and value types come from the
 * source file, so every read is coerced before use.
 */
export type RawImportRow = Record<string, unknown>;

/** A stock item resolved from an import row. */
export type MappedStockItem = {
  name: string;
  code: string | null;
  sellingPrice: string;
  reorderLevel: string;
  stockGroupId: number | null;
};

/** A customer resolved from an import row. */
export type MappedCustomer = {
  name: string;
  legalName: string;
  code: string | null;
  phone: string | null;
  email: string | null;
};

/** A supplier resolved from an import row. */
export type MappedSupplier = {
  legalName: string;
  code: string | null;
  phone: string | null;
  email: string | null;
  openingBalance: string;
};

/** A voucher resolved from an import row. */
export type MappedVoucher = {
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
    const sellingPrice =
      parseMoneyInput(String(raw.sellingPrice ?? raw["Selling Price"] ?? raw.price ?? 0))?.toNumber() ?? NaN;
    if (isNaN(sellingPrice) || sellingPrice < 0) errors.push("sellingPrice must be a non-negative number");
    mapped.sellingPrice = isNaN(sellingPrice) ? "0" : sellingPrice.toFixed(2);

    // reorderLevel
    const reorderLevel =
      parseMoneyInput(String(raw.reorderLevel ?? raw["Reorder Level"] ?? raw.reorder ?? 0))?.toNumber() ?? NaN;
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
