import { eq, and, isNull, asc } from "drizzle-orm";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type { LedgerAccount, InsertLedgerAccount } from "@shared/schema";

// ---------------------------------------------------------------------------
// Ledger Accounts
// ---------------------------------------------------------------------------

export async function getAllLedgerAccounts(
  companyId: number,
  includeHidden: boolean = false
): Promise<LedgerAccount[]> {
  const conditions = [eq(schema.ledgerAccounts.companyId, companyId), isNull(schema.ledgerAccounts.deletedAt)];
  if (!includeHidden) {
    conditions.push(eq(schema.ledgerAccounts.isHidden, false));
  }
  return await db
    .select()
    .from(schema.ledgerAccounts)
    .where(and(...conditions))
    .orderBy(asc(schema.ledgerAccounts.code));
}

export async function getLedgerAccountByCode(code: string, companyId: number): Promise<LedgerAccount | undefined> {
  const [account] = await db
    .select()
    .from(schema.ledgerAccounts)
    .where(
      and(
        eq(schema.ledgerAccounts.code, code),
        eq(schema.ledgerAccounts.companyId, companyId),
        isNull(schema.ledgerAccounts.deletedAt)
      )
    );
  return account;
}

export async function getLedgerAccountByName(name: string, companyId: number): Promise<LedgerAccount | undefined> {
  const [account] = await db
    .select()
    .from(schema.ledgerAccounts)
    .where(
      and(
        eq(schema.ledgerAccounts.name, name),
        eq(schema.ledgerAccounts.companyId, companyId),
        isNull(schema.ledgerAccounts.deletedAt)
      )
    );
  return account;
}

/**
 * Callers sometimes hand over a whole persisted row rather than a fresh insert
 * payload — structural typing accepts it — so the parameter admits the two
 * persistence-owned fields and the body strips them. Declaring them here rather
 * than casting keeps the strip visible to the compiler.
 */
export async function createLedgerAccount(
  account: InsertLedgerAccount & Partial<Pick<LedgerAccount, "id" | "createdAt">>
): Promise<LedgerAccount> {
  const { id: _id, createdAt: _ca, ...fields } = account;
  const [created] = await db
    .insert(schema.ledgerAccounts)
    .values({
      ...fields,
      code: account.code || `LA-${Date.now()}`,
    })
    .returning();
  return created;
}

export async function getOrCreateLedgerAccount(account: InsertLedgerAccount): Promise<LedgerAccount> {
  const code = account.code || `LA-${Date.now()}`;

  const [existingByCode] = await db
    .select()
    .from(schema.ledgerAccounts)
    .where(and(eq(schema.ledgerAccounts.companyId, account.companyId), eq(schema.ledgerAccounts.code, code)))
    .limit(1);

  if (existingByCode) {
    if (existingByCode.deletedAt !== null) {
      const [reactivated] = await db
        .update(schema.ledgerAccounts)
        .set({ deletedAt: null, active: true })
        .where(eq(schema.ledgerAccounts.id, existingByCode.id))
        .returning();
      return reactivated;
    }
    return existingByCode;
  }

  try {
    const [created] = await db
      .insert(schema.ledgerAccounts)
      .values({
        companyId: account.companyId,
        code,
        name: account.name,
        accountType: account.accountType,
        subType: account.subType ?? null,
        parentId: account.parentId ?? null,
        openingBalance: account.openingBalance ?? "0",
        openingBalanceSide: account.openingBalanceSide ?? "Dr",
        active: account.active ?? true,
      })
      .returning();
    return created;
  } catch (insertErr: unknown) {
    const [byCode] = await db
      .select()
      .from(schema.ledgerAccounts)
      .where(and(eq(schema.ledgerAccounts.companyId, account.companyId), eq(schema.ledgerAccounts.code, code)))
      .limit(1);
    if (byCode) {
      if (byCode.deletedAt !== null) {
        const [reactivated] = await db
          .update(schema.ledgerAccounts)
          .set({ deletedAt: null, active: true })
          .where(eq(schema.ledgerAccounts.id, byCode.id))
          .returning();
        return reactivated;
      }
      return byCode;
    }

    const [byName] = await db
      .select()
      .from(schema.ledgerAccounts)
      .where(and(eq(schema.ledgerAccounts.companyId, account.companyId), eq(schema.ledgerAccounts.name, account.name)))
      .limit(1);
    if (byName) {
      if (byName.deletedAt !== null) {
        const [reactivated] = await db
          .update(schema.ledgerAccounts)
          .set({ deletedAt: null, active: true })
          .where(eq(schema.ledgerAccounts.id, byName.id))
          .returning();
        return reactivated;
      }
      return byName;
    }

    logger.error("[getOrCreateLedgerAccount] INSERT failed and no existing row found", {
      code: (insertErr as { code?: string }).code,
      companyId: account.companyId,
      accountCode: code,
      name: account.name,
      error: getErrorMessage(insertErr),
    });
    throw insertErr;
  }
}

export async function deleteLedgerAccount(id: number): Promise<void> {
  await db
    .update(schema.ledgerAccounts)
    .set({ deletedAt: new Date(), active: false })
    .where(eq(schema.ledgerAccounts.id, id));
}

export async function getLedgerAccountById(id: number): Promise<LedgerAccount | undefined> {
  const [account] = await db.select().from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.id, id));
  return account;
}

export async function updateLedgerAccount(account: schema.UpdateLedgerAccount): Promise<LedgerAccount> {
  const { id, ...updates } = account;
  const [updated] = await db
    .update(schema.ledgerAccounts)
    .set(updates)
    .where(eq(schema.ledgerAccounts.id, id))
    .returning();
  return updated;
}

// ---------------------------------------------------------------------------
// Bank Accounts
// ---------------------------------------------------------------------------
