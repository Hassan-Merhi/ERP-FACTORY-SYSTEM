// Extracted from ./_helpers.ts
import { db } from "../../db";
import { logAudit } from "../_helpers";
import { stockItems, customers, suppliers } from "@shared/schema";
import { type MappedCustomer, type MappedStockItem, type MappedSupplier } from "./_helpersValidateStockItemRows";

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
