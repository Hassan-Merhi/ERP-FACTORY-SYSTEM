// Extracted from ./companyImportRoutes.ts: a stage of companyImportRoutes.
import { assertStockImportAllowedTx } from "../../../services/factory/stockImportPolicy";
import {
  factorySuppliers,
  factoryCategories,
  factoryBaleProducts,
  factoryBaleSequences,
  stockItems,
  stockGroups,
  customerInvoiceSequences,
  customerBalances,
  customers,
  ledgerAccounts,
  locations,
  factoryFxRates,
  companySettings,
  factorySettings,
  bankAccounts,
  inventory,
  exchangeRates,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { asDynamicInsert, insertedIdOf } from "./companyImportRoutesHelpers";
import type { companyImportRoutesStep } from "./companyImportRoutesStep";
import type { DynamicTable, ImportRow } from "./companyImportRoutes";
import type { DbTransaction } from "../../../db";

type CompanyImportRoutesStepResult = Awaited<ReturnType<typeof companyImportRoutesStep>>;

export async function companyImportRoutesStep2({
  tx,
  ci1,
  r,
}: {
  tx: DbTransaction;
  ci1: Extract<CompanyImportRoutesStepResult, { done: false }>;
  r: (key: string, oldId: number | null | undefined) => number | null;
}) {
  const { targetCompanyId, fixDates, remap, summary, t, makeUniqueCode } = ci1;
  // Phase 19 C (F7/DI10): takes the cut-over lock and is refused once the
  // cut-over is applied (409); the replaced settings are cleared in this
  // transaction (they were cleared before it, so a failed import lost them).
  await assertStockImportAllowedTx(tx, targetCompanyId);
  await tx.delete(factorySettings).where(eq(factorySettings.companyId, targetCompanyId));
  await tx.delete(factoryBaleSequences).where(eq(factoryBaleSequences.companyId, targetCompanyId));
  await tx.delete(customerInvoiceSequences).where(eq(customerInvoiceSequences.companyId, targetCompanyId));
  await tx.delete(companySettings).where(eq(companySettings.companyId, targetCompanyId));
  async function insertAndMap(
    tableName: string,
    drizzleTable: DynamicTable,
    rows: ImportRow[],
    fkRemaps: Record<string, string>,
    opts?: { hasCompanyId?: boolean; nullifyFields?: string[] }
  ) {
    const hasCompanyId = opts?.hasCompanyId !== false;
    const nullifyFields = opts?.nullifyFields || [];
    let count = 0;
    for (const row of rows) {
      const oldId = row.id;
      const rec = fixDates({ ...row });
      delete rec.id;
      if (hasCompanyId) rec.companyId = targetCompanyId;
      for (const [fkField, remapKey] of Object.entries(fkRemaps)) {
        rec[fkField] = r(remapKey, rec[fkField] as number | null | undefined);
      }
      for (const field of nullifyFields) {
        rec[field] = null;
      }
      const [inserted] = await tx.insert(drizzleTable).values(rec).returning({ id: drizzleTable.id });
      const insertedId = insertedIdOf(inserted);
      if (insertedId != null && oldId != null) {
        remap[tableName].set(oldId, insertedId);
      }
      count++;
    }
    summary[tableName] = count;
    ci1.totalRecords += count;
  }

  async function insertSelfReferencing(
    tableName: string,
    drizzleTable: DynamicTable,
    rows: ImportRow[],
    parentField: string,
    fkRemaps: Record<string, string>,
    opts?: { hasCompanyId?: boolean }
  ) {
    const hasCompanyId = opts?.hasCompanyId !== false;
    const roots = rows.filter((r) => r[parentField] == null);
    const children = rows.filter((r) => r[parentField] != null);
    let count = 0;

    for (const row of roots) {
      const oldId = row.id;
      const rec = fixDates({ ...row });
      delete rec.id;
      if (hasCompanyId) rec.companyId = targetCompanyId;
      rec[parentField] = null;
      for (const [fkField, remapKey] of Object.entries(fkRemaps)) {
        rec[fkField] = r(remapKey, rec[fkField] as number | null | undefined);
      }
      const [inserted] = await tx.insert(drizzleTable).values(rec).returning({ id: drizzleTable.id });
      const insertedId = insertedIdOf(inserted);
      if (insertedId != null && oldId != null) remap[tableName].set(oldId, insertedId);
      count++;
    }

    let remaining = [...children];
    let maxPasses = 20;
    while (remaining.length > 0 && maxPasses > 0) {
      const nextRemaining: ImportRow[] = [];
      for (const row of remaining) {
        const parentMapped = r(tableName, row[parentField] as number | null | undefined);
        if (parentMapped != null) {
          const oldId = row.id;
          const rec = fixDates({ ...row });
          delete rec.id;
          if (hasCompanyId) rec.companyId = targetCompanyId;
          rec[parentField] = parentMapped;
          for (const [fkField, remapKey] of Object.entries(fkRemaps)) {
            rec[fkField] = r(remapKey, rec[fkField] as number | null | undefined);
          }
          const [inserted] = await tx.insert(drizzleTable).values(rec).returning({ id: drizzleTable.id });
          const insertedId = insertedIdOf(inserted);
          if (insertedId != null && oldId != null) remap[tableName].set(oldId, insertedId);
          count++;
        } else {
          nextRemaining.push(row);
        }
      }
      remaining = nextRemaining;
      maxPasses--;
    }

    if (remaining.length > 0) {
      for (const row of remaining) {
        const oldId = row.id;
        const rec = fixDates({ ...row });
        delete rec.id;
        if (hasCompanyId) rec.companyId = targetCompanyId;
        rec[parentField] = null;
        for (const [fkField, remapKey] of Object.entries(fkRemaps)) {
          rec[fkField] = r(remapKey, rec[fkField] as number | null | undefined);
        }
        const [inserted] = await tx.insert(drizzleTable).values(rec).returning({ id: drizzleTable.id });
        const insertedId = insertedIdOf(inserted);
        if (insertedId != null && oldId != null) remap[tableName].set(oldId, insertedId);
        count++;
      }
    }

    summary[tableName] = count;
    ci1.totalRecords += count;
  }

  if (t.locations?.length) {
    for (const row of t.locations) {
      const oldId = row.id;
      const rec = fixDates({ ...row });
      delete rec.id;
      rec.companyId = targetCompanyId;
      rec.code = await makeUniqueCode(tx, locations, locations.code, String(rec.code));
      const [inserted] = await tx.insert(locations).values(asDynamicInsert(rec)).returning({ id: locations.id });
      if (inserted && oldId != null) remap["locations"].set(oldId, inserted.id);
    }
    summary["locations"] = t.locations.length;
    ci1.totalRecords += t.locations.length;
  }

  if (t.ledger_accounts?.length) {
    await insertSelfReferencing("ledger_accounts", ledgerAccounts, t.ledger_accounts, "parentId", {});
  }

  if (t.bank_accounts?.length) {
    for (const row of t.bank_accounts) {
      const oldId = row.id;
      const rec = fixDates({ ...row });
      delete rec.id;
      rec.companyId = targetCompanyId;
      rec.linkedLedgerId = r("ledger_accounts", rec.linkedLedgerId as number | null | undefined);
      rec.code = await makeUniqueCode(tx, bankAccounts, bankAccounts.code, String(rec.code));
      const [inserted] = await tx.insert(bankAccounts).values(asDynamicInsert(rec)).returning({ id: bankAccounts.id });
      if (inserted && oldId != null) remap["bank_accounts"].set(oldId, inserted.id);
    }
    summary["bank_accounts"] = t.bank_accounts.length;
    ci1.totalRecords += t.bank_accounts.length;
  }

  if (t.stock_groups?.length) {
    await insertSelfReferencing("stock_groups", stockGroups, t.stock_groups, "parentId", {});
  }

  if (t.stock_items?.length) {
    await insertAndMap("stock_items", stockItems, t.stock_items, { stockGroupId: "stock_groups" });
  }

  if (t.inventory?.length) {
    await insertAndMap("inventory", inventory, t.inventory, {
      locationId: "locations",
      stockItemId: "stock_items",
    });
  }

  if (t.company_settings?.length) {
    await insertAndMap("company_settings", companySettings, t.company_settings, {
      parentCreditAccountId: "ledger_accounts",
    });
  }

  if (t.exchange_rates?.length) {
    await insertAndMap("exchange_rates", exchangeRates, t.exchange_rates, {});
  }

  if (t.customers?.length) {
    await insertAndMap("customers", customers, t.customers, { ledgerAccountId: "ledger_accounts" });
  }

  if (t.customer_balances?.length) {
    await insertAndMap("customer_balances", customerBalances, t.customer_balances, {
      customerId: "customers",
    });
  }

  if (t.factory_settings?.length) {
    await insertAndMap("factory_settings", factorySettings, t.factory_settings, {});
  }

  if (t.factory_suppliers?.length) {
    await insertAndMap("factory_suppliers", factorySuppliers, t.factory_suppliers, {});
  }

  if (t.factory_categories?.length) {
    await insertAndMap("factory_categories", factoryCategories, t.factory_categories, {});
  }

  if (t.factory_bale_products?.length) {
    await insertAndMap("factory_bale_products", factoryBaleProducts, t.factory_bale_products, {
      categoryId: "factory_categories",
    });
  }

  if (t.factory_fx_rates?.length) {
    await insertAndMap("factory_fx_rates", factoryFxRates, t.factory_fx_rates, {});
  }

  if (t.factory_bale_sequences?.length) {
    await insertAndMap("factory_bale_sequences", factoryBaleSequences, t.factory_bale_sequences, {});
  }

  return { insertAndMap };
}
