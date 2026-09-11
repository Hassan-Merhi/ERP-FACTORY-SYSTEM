import { and, desc, eq, inArray, or } from "drizzle-orm";
import { auditLog, interCompanyTransfers, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import type { InsertLedgerAccount, LedgerAccount } from "@shared/schema";

import { db } from "../../db";
import { storage } from "../../storage";

const IDEMPOTENCY_TABLE = "accounting_posting_idempotency";

function transferReversalKeys(transferId: number): string[] {
  return [`simple-company-transfer-reversal:${transferId}:from`, `simple-company-transfer-reversal:${transferId}:to`];
}

export const transferRepository = {
  transaction<T>(callback: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T> {
    return db.transaction(callback);
  },

  getCompany(companyId: number) {
    return storage.getCompanyById(companyId);
  },

  getLedgerAccount(accountId: number) {
    return storage.getLedgerAccountById(accountId);
  },

  listLedgerAccounts(companyId: number, includeHidden = false) {
    return storage.getAllLedgerAccounts(companyId, includeHidden);
  },

  createLedgerAccount(values: InsertLedgerAccount & Partial<Pick<LedgerAccount, "id" | "createdAt">>) {
    return storage.createLedgerAccount(values);
  },

  listInterCompanyTransfers(companyId: number) {
    return storage.getAllInterCompanyTransfers(companyId);
  },

  async createTransferTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    values: typeof interCompanyTransfers.$inferInsert
  ) {
    const [transfer] = await tx.insert(interCompanyTransfers).values(values).returning();
    return transfer;
  },

  async findTransferByVoucherIdsTx(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], fromVoucherId: number, toVoucherId: number) {
    const [transfer] = await tx
      .select()
      .from(interCompanyTransfers)
      .where(
        and(eq(interCompanyTransfers.fromVoucherId, fromVoucherId), eq(interCompanyTransfers.toVoucherId, toVoucherId))
      )
      .limit(1);
    return transfer ?? null;
  },

  getSimpleTransfer(transferId: number) {
    return db
      .select()
      .from(interCompanyTransfers)
      .where(eq(interCompanyTransfers.id, transferId))
      .then((rows) => rows[0] ?? null);
  },

  async hasCompletedTransferReversal(transferId: number): Promise<boolean> {
    const keys = transferReversalKeys(transferId);
    const rows = await db
      .select({ key: auditLog.recordIdentifier })
      .from(auditLog)
      .where(and(eq(auditLog.tableName, IDEMPOTENCY_TABLE), inArray(auditLog.recordIdentifier, keys)));
    return new Set(rows.map((row) => row.key).filter(Boolean)).size === keys.length;
  },

  async getSimpleTransferForUpdateTx(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], transferId: number) {
    const [transfer] = await tx
      .select()
      .from(interCompanyTransfers)
      .where(eq(interCompanyTransfers.id, transferId))
      .for("update")
      .limit(1);
    return transfer ?? null;
  },

  async getVoucherSnapshotTx(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], companyId: number, voucherId: number) {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
      .limit(1);
    if (!voucher) return null;
    const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
    return { voucher, entries };
  },

  async listSimpleTransfers(companyId: number) {
    const transfers = await db
      .select()
      .from(interCompanyTransfers)
      .where(or(eq(interCompanyTransfers.fromCompanyId, companyId), eq(interCompanyTransfers.toCompanyId, companyId)))
      .orderBy(desc(interCompanyTransfers.createdAt));

    const accountIds = Array.from(
      new Set(
        transfers.flatMap((transfer) => [transfer.fromLedgerAccountId, transfer.toLedgerAccountId]).filter(Boolean)
      )
    ) as number[];
    const [companies, accounts] = await Promise.all([
      storage.getAllCompanies(),
      accountIds.length > 0
        ? db.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, accountIds))
        : Promise.resolve(([])),
    ]);
    const companyMap = new Map(companies.map((company) => [company.id, company]));
    const accountMap = new Map(accounts.map((account) => [account.id, account]));

    return transfers.map((transfer) => ({
      ...transfer,
      fromCompanyName: companyMap.get(transfer.fromCompanyId)?.name ?? "Unknown",
      toCompanyName: companyMap.get(transfer.toCompanyId)?.name ?? "Unknown",
      fromAccountName: accountMap.get(transfer.fromLedgerAccountId)?.name ?? "Unknown",
      toAccountName: accountMap.get(transfer.toLedgerAccountId)?.name ?? "Unknown",
    }));
  },

  async deleteSimpleTransferTx(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], transferId: number): Promise<void> {
    await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transferId));
  },
};
