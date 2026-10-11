import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

export async function getAllInterCompanyTransfers(companyId?: number): Promise<schema.InterCompanyTransfer[]> {
  if (companyId) {
    return await db
      .select()
      .from(schema.interCompanyTransfers)
      .where(
        and(
          or(
            eq(schema.interCompanyTransfers.fromCompanyId, companyId),
            eq(schema.interCompanyTransfers.toCompanyId, companyId)
          ),
          // Phase 26 (MC-11): a soft-deleted link is history, not a transfer.
          isNull(schema.interCompanyTransfers.deletedAt)
        )
      )
      .orderBy(sql`${schema.interCompanyTransfers.transferDate} DESC`);
  }
  return await db
    .select()
    .from(schema.interCompanyTransfers)
    .where(isNull(schema.interCompanyTransfers.deletedAt))
    .orderBy(sql`${schema.interCompanyTransfers.transferDate} DESC`);
}

export async function getInterCompanyTransferById(id: number): Promise<schema.InterCompanyTransfer | undefined> {
  const [transfer] = await db
    .select()
    .from(schema.interCompanyTransfers)
    .where(eq(schema.interCompanyTransfers.id, id));
  return transfer;
}

export async function createInterCompanyTransfer(
  transfer: schema.InsertInterCompanyTransfer
): Promise<schema.InterCompanyTransfer> {
  const [newTransfer] = await db.insert(schema.interCompanyTransfers).values(transfer).returning();
  return newTransfer;
}

// ---------------------------------------------------------------------------
// Company Settings
// ---------------------------------------------------------------------------

export async function getCompanySettings(companyId: number): Promise<schema.CompanySettings | undefined> {
  const [settings] = await db
    .select()
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId));
  return settings;
}

export async function getConfiguredIntercompanyCreditAccount(
  companyId: number
): Promise<schema.LedgerAccount | undefined> {
  const settings = await getCompanySettings(companyId);
  const configuredAccountId = settings?.parentCreditAccountId;
  if (configuredAccountId == null) return undefined;

  const [account] = await db
    .select()
    .from(schema.ledgerAccounts)
    .where(
      and(
        eq(schema.ledgerAccounts.id, configuredAccountId),
        eq(schema.ledgerAccounts.companyId, companyId),
        eq(schema.ledgerAccounts.active, true),
        isNull(schema.ledgerAccounts.deletedAt)
      )
    )
    .limit(1);

  if (!account) {
    throw new Error("intercompany_credit_account_invalid");
  }

  return account;
}

export async function upsertCompanySettings(settings: schema.InsertCompanySettings): Promise<schema.CompanySettings> {
  const existing = await getCompanySettings(settings.companyId);
  if (existing) {
    const [updated] = await db
      .update(schema.companySettings)
      .set({ ...settings, updatedAt: sql`now()` })
      .where(eq(schema.companySettings.companyId, settings.companyId))
      .returning();
    return updated;
  } else {
    const [created] = await db.insert(schema.companySettings).values(settings).returning();
    return created;
  }
}

// ---------------------------------------------------------------------------
// Customer Balance
// ---------------------------------------------------------------------------
