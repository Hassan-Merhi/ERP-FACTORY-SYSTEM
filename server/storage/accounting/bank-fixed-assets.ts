import { eq, and, isNull, asc, sql, ne } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type { BankAccount, InsertBankAccount, FixedAsset, InsertFixedAsset } from "@shared/schema";

export async function getAllBankAccounts(companyId: number): Promise<BankAccount[]> {
  return await db
    .select()
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.companyId, companyId), isNull(schema.bankAccounts.deletedAt)))
    .orderBy(asc(schema.bankAccounts.code));
}

export async function getBankAccountByCode(code: string): Promise<BankAccount | undefined> {
  const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.code, code));
  return account;
}

export async function getBankAccountById(id: number, companyId: number): Promise<BankAccount | undefined> {
  const [account] = await db
    .select()
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.id, id), eq(schema.bankAccounts.companyId, companyId)));
  return account;
}

export async function createBankAccount(account: InsertBankAccount): Promise<BankAccount> {
  const [created] = await db.insert(schema.bankAccounts).values(account).returning();
  return created;
}

export async function updateBankAccount(
  id: number,
  updates: Partial<InsertBankAccount>,
  companyId: number
): Promise<BankAccount> {
  const existing = await getBankAccountById(id, companyId);
  if (!existing) {
    throw new Error("Bank account not found");
  }

  if (updates.code && updates.code !== existing.code) {
    const [duplicate] = await db
      .select()
      .from(schema.bankAccounts)
      .where(
        and(
          eq(schema.bankAccounts.code, updates.code),
          eq(schema.bankAccounts.companyId, companyId),
          ne(schema.bankAccounts.id, id)
        )
      );
    if (duplicate) {
      throw new Error("Bank account code already exists in this company");
    }
  }

  const [updated] = await db
    .update(schema.bankAccounts)
    .set(updates)
    .where(and(eq(schema.bankAccounts.id, id), eq(schema.bankAccounts.companyId, companyId)))
    .returning();
  if (!updated) {
    throw new Error("Bank account not found");
  }
  return updated;
}

export async function deleteBankAccount(id: number, companyId: number): Promise<void> {
  const existing = await getBankAccountById(id, companyId);
  if (!existing) {
    throw new Error("Bank account not found");
  }

  const entries = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.voucherEntries)
    .where(eq(schema.voucherEntries.bankAccountId, id));

  const entryCount = entries[0]?.count || 0;
  if (entryCount > 0) {
    throw new Error(`Cannot delete bank account: ${entryCount} voucher entries exist`);
  }

  await db
    .update(schema.bankAccounts)
    .set({ deletedAt: new Date(), active: false })
    .where(and(eq(schema.bankAccounts.id, id), eq(schema.bankAccounts.companyId, companyId)));
}

// ---------------------------------------------------------------------------
// Fixed Assets
// ---------------------------------------------------------------------------

export async function getAllFixedAssets(companyId: number): Promise<FixedAsset[]> {
  return await db
    .select()
    .from(schema.fixedAssets)
    .where(and(eq(schema.fixedAssets.companyId, companyId), isNull(schema.fixedAssets.deletedAt)))
    .orderBy(asc(schema.fixedAssets.code));
}

export async function getFixedAssetByCode(code: string): Promise<FixedAsset | undefined> {
  const [asset] = await db.select().from(schema.fixedAssets).where(eq(schema.fixedAssets.code, code));
  return asset;
}

export async function createFixedAsset(asset: InsertFixedAsset): Promise<FixedAsset> {
  const [created] = await db.insert(schema.fixedAssets).values(asset).returning();
  return created;
}

// ---------------------------------------------------------------------------
// Voucher Queries
// ---------------------------------------------------------------------------
