// Extracted from ./permanent-delete.ts: per-type delete handlers.
import { db } from "../../../db";
import { writeAuditEvent } from "../../../services/audit";
import {
  customerOrderCharges,
  stockTransferVouchers,
  stockTransferItems,
  containerSales,
  purchaseOrders,
  vouchers,
  voucherEntries,
  interCompanyTransfers,
  fiscalPeriodClosures,
  wasteDispatches,
  salaryAdvances,
  propertyPayments,
  factoryTransporterTransactions,
  bankAccounts,
  suppliers,
  ledgerAccounts,
  inventory,
  locations,
} from "@shared/schema";
import { eq, and, inArray, sql, ne, or } from "drizzle-orm";
import { isRetiredVoucherNumber } from "../../../services/accounting/voucherRetirement";
import {
  CLOSING_VOUCHER_MESSAGE,
  RETIRED_VOUCHER_NOT_DELETABLE_MESSAGE,
  PermanentDeleteRefused,
  ACCOUNT_HAS_HISTORY_MESSAGE,
  hasOpening,
  firstFound,
  LOCATION_HAS_STOCK_MESSAGE,
} from "./permanent-deleteHelpers";
import type { Request, Response } from "express";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import type { PermanentDeleteStepResult } from "./permanentDeleteCasesHelpers";
export {
  permanentDeleteCustomer,
  permanentDeleteEmployee,
  permanentDeleteStockItem,
} from "./permanentDeleteCasesHelpers";

export async function permanentDeleteVoucher({
  pd1,
  res,
  req,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
  res: Response;
  req: Request;
}) {
  const { itemId, companyId } = pd1;
  // A fiscal close's journal is referenced by its closure row. Deleting
  // that row would silently reopen the period, so refuse instead.
  const [closure] = await db
    .select({ id: fiscalPeriodClosures.id })
    .from(fiscalPeriodClosures)
    .where(eq(fiscalPeriodClosures.closingVoucherId, itemId))
    .limit(1);
  if (closure) {
    return {
      done: true as const,
      value: { done: true as const, value: res.status(409).json({ message: CLOSING_VOUCHER_MESSAGE }) },
    };
  }

  // One transaction: the voucher, its lines and every unlinked
  // reference go together, or nothing changes.
  await db.transaction(async (tx) => {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)))
      .for("update");
    // Wave 18 (B): a voucher the system retired (renamed ~DEL) stays.
    if (isRetiredVoucherNumber(voucher?.voucherNumber)) {
      throw new PermanentDeleteRefused(RETIRED_VOUCHER_NOT_DELETABLE_MESSAGE);
    }
    const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, itemId));

    // ── Step 1: Null out nullable FKs in tables with onDelete: "restrict" ──
    await tx.update(purchaseOrders).set({ voucherId: null }).where(eq(purchaseOrders.voucherId, itemId));
    await tx.update(containerSales).set({ voucherId: null }).where(eq(containerSales.voucherId, itemId));
    await tx
      .update(interCompanyTransfers)
      .set({ fromVoucherId: null })
      .where(eq(interCompanyTransfers.fromVoucherId, itemId));
    await tx
      .update(interCompanyTransfers)
      .set({ toVoucherId: null })
      .where(eq(interCompanyTransfers.toVoucherId, itemId));
    await tx.update(salaryAdvances).set({ voucherId: null }).where(eq(salaryAdvances.voucherId, itemId));
    await tx.update(customerOrderCharges).set({ voucherId: null }).where(eq(customerOrderCharges.voucherId, itemId));
    await tx.update(wasteDispatches).set({ voucherId: null }).where(eq(wasteDispatches.voucherId, itemId));
    await tx.update(propertyPayments).set({ voucherId: null }).where(eq(propertyPayments.voucherId, itemId));
    await tx
      .update(factoryTransporterTransactions)
      .set({ voucherId: null })
      .where(eq(factoryTransporterTransactions.voucherId, itemId));

    // ── Step 2: Delete rows with notNull FKs ──────────────────────────
    // stock_transfer_vouchers.voucherId is notNull — delete its items first
    const stvRows = await tx
      .select({ id: stockTransferVouchers.id })
      .from(stockTransferVouchers)
      .where(eq(stockTransferVouchers.voucherId, itemId));
    if (stvRows.length > 0) {
      const stvIds = stvRows.map((r) => r.id);
      // transferId is the correct FK column on stock_transfer_items
      await tx.delete(stockTransferItems).where(inArray(stockTransferItems.transferId, stvIds));
      await tx.delete(stockTransferVouchers).where(inArray(stockTransferVouchers.id, stvIds));
    }

    // ── Step 3: Delete voucher entries (also cascade, but be explicit) ─
    await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, itemId));

    // ── Step 4: Delete the voucher itself ────────────────────────────
    await tx.delete(vouchers).where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)));

    // ── Step 5: Audit, with the header and lines as they were ────────
    await writeAuditEvent(
      {
        userId: req.session.userId ?? "unknown",
        username: req.session.username || "unknown",
        companyId: companyId,
        action: "delete",
        tableName: "vouchers",
        recordId: itemId,
        recordIdentifier: voucher?.voucherNumber ?? null,
        changes: {
          permanentDelete: { new: true },
          voucher: { old: voucher ?? null },
          entries: { old: entries },
          unlinkedStockTransferVoucherIds: { old: stvRows.map((r) => r.id) },
        },
      },
      tx
    );
  });

  return { done: false as const };
}

export async function permanentDeleteBankAccount({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { removeOne, itemId, companyId } = pd1;
  await removeOne(
    bankAccounts,
    "bank_accounts",
    (tx) => tx.delete(bankAccounts).where(and(eq(bankAccounts.id, itemId), eq(bankAccounts.companyId, companyId))),
    async (tx, row) => {
      if (
        hasOpening(row) ||
        (await firstFound(tx, [sql`SELECT 1 FROM ${voucherEntries} WHERE ${voucherEntries.bankAccountId} = ${itemId}`]))
      ) {
        throw new PermanentDeleteRefused(ACCOUNT_HAS_HISTORY_MESSAGE);
      }
    }
  );
}

export async function permanentDeleteSupplier({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { removeOne, itemId, companyId } = pd1;
  // Wave 18 (B): the active company's supplier only; refused while any
  // voucher line names it or its opening is not zero.
  await removeOne(
    suppliers,
    "suppliers",
    (tx) =>
      tx
        .delete(companyScopedSuppliers)
        .where(and(eq(companyScopedSuppliers.id, itemId), eq(companyScopedSuppliers.companyId, companyId))),
    async (tx, row) => {
      if (
        hasOpening(row) ||
        (await firstFound(tx, [sql`SELECT 1 FROM ${voucherEntries} WHERE ${voucherEntries.supplierId} = ${itemId}`]))
      ) {
        throw new PermanentDeleteRefused(ACCOUNT_HAS_HISTORY_MESSAGE);
      }
    }
  );
}

export async function permanentDeleteLedgerAccount({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { removeOne, itemId, companyId } = pd1;
  // Wave 18 (B): refused while any voucher line (live or deleted voucher)
  // names the account or its opening is not zero.
  await removeOne(
    ledgerAccounts,
    "ledger_accounts",
    (tx) =>
      tx.delete(ledgerAccounts).where(and(eq(ledgerAccounts.id, itemId), eq(ledgerAccounts.companyId, companyId))),
    async (tx, row) => {
      if (
        hasOpening(row) ||
        (await firstFound(tx, [
          sql`SELECT 1 FROM ${voucherEntries} WHERE ${voucherEntries.ledgerAccountId} = ${itemId}`,
        ]))
      ) {
        throw new PermanentDeleteRefused(ACCOUNT_HAS_HISTORY_MESSAGE);
      }
    }
  );
}

export async function permanentDeleteLocation({
  pd1,
  req,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
  req: Request;
}) {
  const { itemId, companyId } = pd1;
  // Wave 16 (A): refused while any inventory row of the location holds
  // a quantity or a value; the stock (and the ledger's inventory)
  // would lose its location. One transaction, audited.
  await db.transaction(async (tx) => {
    const [location] = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.id, itemId), eq(locations.companyId, companyId)))
      .for("update");
    const held = await tx
      .select({ id: inventory.id })
      .from(inventory)
      .where(and(eq(inventory.locationId, itemId), or(ne(inventory.quantity, "0"), ne(inventory.totalValue, "0"))))
      .limit(1);
    if (held.length > 0) throw new PermanentDeleteRefused(LOCATION_HAS_STOCK_MESSAGE);
    await tx.delete(locations).where(and(eq(locations.id, itemId), eq(locations.companyId, companyId)));
    await writeAuditEvent(
      {
        userId: req.session.userId ?? "unknown",
        username: req.session.username || "unknown",
        companyId: companyId,
        action: "delete",
        tableName: "locations",
        recordId: itemId,
        recordIdentifier: location?.code ?? null,
        changes: { permanentDelete: { new: true }, location: { old: location ?? null } },
      },
      tx
    );
  });
}
