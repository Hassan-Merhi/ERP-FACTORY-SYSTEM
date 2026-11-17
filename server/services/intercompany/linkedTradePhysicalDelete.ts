/**
 * Physical removal of a pristine intercompany import. Unlike Phase 5
 * cancellation this creates NO reversal journal. It is deliberately fail
 * closed: any independent financial/stock activity must use the audited
 * cancellation/reconciliation workflow instead.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  containerCharges,
  containers,
  importLogs,
  intercompanyAuditEvents,
  intercompanyDestinationReceipts,
  intercompanyImportBatchContainers,
  intercompanyImportBatches,
  intercompanyPaymentAllocations,
  intercompanySharedChargeAllocations,
  intercompanySharedChargePoAllocations,
  intercompanyTradeCancellations,
  intercompanyTradeLineLinks,
  intercompanyTradeRevisions,
  intercompanyTradeSourcePos,
  intercompanyTrades,
  poLineItems,
  purchaseOrders,
  vouchers,
} from "@shared/schema";
import { db } from "../../db";
import { INTERCOMPANY_PAYMENT_LOCK_NAMESPACE } from "./paymentAllocationCore";
import {
  assertTradeAccess,
  loadTradeTx,
  rejectEdit,
  requireUnreceived,
  type EditIdentity,
  withTradeScope,
} from "./tradeSync";

const idsOf = (value: unknown): number[] =>
  Array.isArray(value) && value.every((v) => Number.isSafeInteger(v) && v > 0) ? (value as number[]) : [];

export function deletionVoucherIds(payload: unknown): number[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const list = [
    ...idsOf(record.originalSupplierVoucherIds),
    record.sourceSaleVoucherId,
    record.sourceCostVoucherId,
    record.destinationVoucherId,
  ];
  return list.filter((n): n is number => Number.isSafeInteger(n) && Number(n) > 0);
}

export async function findLinkedTradeForPo(poId: number): Promise<number | null> {
  const [dest] = await db
    .select({ id: intercompanyTrades.id })
    .from(intercompanyTrades)
    .where(eq(intercompanyTrades.destinationPoId, poId))
    .limit(1);
  if (dest) return dest.id;
  const [source] = await db
    .select({ tradeId: intercompanyTradeSourcePos.tradeId })
    .from(intercompanyTradeSourcePos)
    .where(eq(intercompanyTradeSourcePos.sourcePoId, poId))
    .limit(1);
  return source?.tradeId ?? null;
}

// Resolve the original import vouchers only; other voucher families must
// never be treated as permission to delete their linked financial records.
export async function daybookLinkedVoucherTrades(voucherIds: readonly number[], actor: EditIdentity) {
  if (!voucherIds.length || voucherIds.length > 100 || voucherIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    rejectEdit("Invalid Daybook voucher selection", "IC_DELETE_IDS", 422);
  }
  const trades = await withTradeScope(actor, [], () =>
    db
      .select()
      .from(intercompanyTrades)
      .where(
        or(
          eq(intercompanyTrades.sourceCompanyId, actor.initiatingCompanyId),
          eq(intercompanyTrades.destinationCompanyId, actor.initiatingCompanyId)
        )
      )
  );
  if (!trades.length) return {} as Record<number, { tradeId: number; version: number }>;
  return withTradeScope(
    actor,
    trades.flatMap((t) => [t.sourceCompanyId, t.destinationCompanyId]),
    async () => {
      const events = await db
        .select()
        .from(intercompanyAuditEvents)
        .where(
          and(
            inArray(intercompanyAuditEvents.relationshipId, [...new Set(trades.map((t) => t.relationshipId))]),
            eq(intercompanyAuditEvents.eventType, "container-import-confirmed")
          )
        );
      const candidates = new Set(voucherIds);
      const output: Record<number, { tradeId: number; version: number }> = {};
      for (const trade of trades) {
        if (trade.state !== "active") continue;
        const event = events.find(
          (row) =>
            row.eventKey.startsWith("ic-container-import:") &&
            row.eventKey.endsWith(":" + trade.id) &&
            (row.payload as Record<string, unknown> | null)?.physicalContainerId === trade.physicalContainerId
        );
        if (!event) continue;
        for (const id of deletionVoucherIds(event.payload)) {
          if (candidates.has(id)) output[id] = { tradeId: trade.id, version: trade.version };
        }
      }
      return output;
    }
  );
}

export async function deletePristineLinkedTrade(tradeId: number, expectedVersion: number, actor: EditIdentity) {
  if (!["Owner", "Developer"].includes(actor.actorRole)) {
    rejectEdit("Only an Owner or Developer may delete linked POs in both companies", "IC_DELETE_FORBIDDEN", 403);
  }
  const authorized = await assertTradeAccess(tradeId, actor);
  return withTradeScope(actor, [authorized.sourceCompanyId, authorized.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          "SELECT pg_advisory_xact_lock(" + INTERCOMPANY_PAYMENT_LOCK_NAMESPACE + "," + authorized.sourceCompanyId + ")"
        )
      );
      const data = await loadTradeTx(tx, tradeId);
      if (data.trade.version !== expectedVersion) {
        rejectEdit("Linked PO was modified; refresh before deleting", "IC_DELETE_STALE");
      }
      requireUnreceived(data);
      const [receipt, allocations, shared, sharedPo, revisions, canceled] = await Promise.all([
        tx
          .select({ id: intercompanyDestinationReceipts.id })
          .from(intercompanyDestinationReceipts)
          .where(eq(intercompanyDestinationReceipts.tradeId, tradeId))
          .limit(1),
        tx
          .select({ id: intercompanyPaymentAllocations.id })
          .from(intercompanyPaymentAllocations)
          .where(eq(intercompanyPaymentAllocations.tradeId, tradeId))
          .limit(1),
        tx
          .select({ id: intercompanySharedChargeAllocations.id })
          .from(intercompanySharedChargeAllocations)
          .where(eq(intercompanySharedChargeAllocations.tradeId, tradeId))
          .limit(1),
        tx
          .select({ id: intercompanySharedChargePoAllocations.id })
          .from(intercompanySharedChargePoAllocations)
          .where(eq(intercompanySharedChargePoAllocations.tradeId, tradeId))
          .limit(1),
        tx
          .select({ id: intercompanyTradeRevisions.id })
          .from(intercompanyTradeRevisions)
          .where(eq(intercompanyTradeRevisions.tradeId, tradeId))
          .limit(1),
        tx
          .select({ id: intercompanyTradeCancellations.id })
          .from(intercompanyTradeCancellations)
          .where(eq(intercompanyTradeCancellations.tradeId, tradeId))
          .limit(1),
      ]);
      if (
        receipt.length ||
        allocations.length ||
        shared.length ||
        sharedPo.length ||
        revisions.length ||
        canceled.length
      ) {
        rejectEdit(
          "Linked PO has receipts, payments, revised prices, charges or cancellation history. Physical deletion is unsafe.",
          "IC_DELETE_DEPENDENCY"
        );
      }

      // A physical container can have several source POs but only one active
      // linked destination PO. Never delete a subset of a connected trade.
      const linkedPos = [...data.source.map((item) => item.po), data.destination.po];
      const poIds = linkedPos.map((po) => po.id);
      const allPos = await tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.containerId, data.physical.id));
      if (allPos.length !== poIds.length || allPos.some((po) => !poIds.includes(po.id))) {
        rejectEdit("Container has unrelated POs; refusing linked deletion", "IC_DELETE_EXTRA_PO");
      }
      const activeSiblings = await tx
        .select({ id: intercompanyTrades.id })
        .from(intercompanyTrades)
        .where(eq(intercompanyTrades.physicalContainerId, data.physical.id));
      if (activeSiblings.length !== 1 || activeSiblings[0].id !== tradeId) {
        rejectEdit("Container has other intercompany records", "IC_DELETE_OTHER_TRADE");
      }

      const audit = await tx
        .select()
        .from(intercompanyAuditEvents)
        .where(
          and(
            eq(intercompanyAuditEvents.relationshipId, data.trade.relationshipId),
            eq(intercompanyAuditEvents.eventType, "container-import-confirmed")
          )
        );
      const sourceAudit = audit.find(
        (entry) =>
          entry.eventKey.endsWith(":" + tradeId) &&
          entry.eventKey.startsWith("ic-container-import:") &&
          (entry.payload as Record<string, unknown> | null)?.physicalContainerId === data.physical.id
      );
      const originalVoucherIds = deletionVoucherIds(sourceAudit?.payload);
      // A historical account normalization is another original-trade-owned
      // voucher and must be deleted in the same atomic PO cleanup.
      const [normalization] = await tx
        .select({ payload: intercompanyAuditEvents.payload })
        .from(intercompanyAuditEvents)
        .where(eq(intercompanyAuditEvents.eventKey, "ic-technical-profit-normalized:" + tradeId))
        .limit(1);
      const normalizationVoucherId = (normalization?.payload as { voucherId?: unknown } | null)?.voucherId;
      if (normalization && (!Number.isSafeInteger(normalizationVoucherId) || Number(normalizationVoucherId) <= 0)) {
        rejectEdit("Historical accounting normalization voucher evidence is invalid", "IC_DELETE_NETTING_EVIDENCE");
      }
      const voucherIds = [...originalVoucherIds, ...(normalization ? [Number(normalizationVoucherId)] : [])];
      const expectedVoucherIds = linkedPos.map((po) => po.voucherId);
      if (
        !sourceAudit ||
        originalVoucherIds.length !== data.source.length + 3 ||
        expectedVoucherIds.some((id) => id == null || !voucherIds.includes(id)) ||
        new Set(voucherIds).size !== voucherIds.length
      ) {
        rejectEdit("Cannot verify every original voucher. Nothing was deleted.", "IC_DELETE_VOUCHER_EVIDENCE");
      }
      const posted = await tx
        .select({
          id: vouchers.id,
          companyId: vouchers.companyId,
          voucherNumber: vouchers.voucherNumber,
          deletedAt: vouchers.deletedAt,
        })
        .from(vouchers)
        .where(inArray(vouchers.id, voucherIds))
        .for("update");
      if (
        posted.length !== voucherIds.length ||
        posted.some(
          (voucher) =>
            voucher.deletedAt ||
            ![data.trade.sourceCompanyId, data.trade.destinationCompanyId].includes(voucher.companyId)
        )
      ) {
        rejectEdit("One or more linked vouchers changed or were already deleted", "IC_DELETE_VOUCHER_STALE");
      }
      // Financial dependencies on any of these vouchers are left to database
      // FK constraints (which abort the ENTIRE transaction) rather than CASCADE.
      // Never delete independent receipts, payments, stock or audit records.
      await tx.execute(sql`SELECT set_config('erp.ic_physical_delete', ${String(tradeId)}, true)`);
      await tx.delete(intercompanyTradeLineLinks).where(eq(intercompanyTradeLineLinks.tradeId, tradeId));
      await tx.delete(intercompanyTradeSourcePos).where(eq(intercompanyTradeSourcePos.tradeId, tradeId));
      await tx.delete(intercompanyImportBatchContainers).where(eq(intercompanyImportBatchContainers.tradeId, tradeId));
      await tx.delete(intercompanyTrades).where(eq(intercompanyTrades.id, tradeId));
      await tx.delete(poLineItems).where(inArray(poLineItems.poId, poIds));
      await tx.delete(purchaseOrders).where(inArray(purchaseOrders.id, poIds));

      // Remove only original engine idempotency rows, never external voucher
      // data. Voucher entries use the voucher FK's ON DELETE CASCADE.
      await tx.execute(sql`DELETE FROM accounting_posting_requests
        WHERE voucher_id IN (${sql.join(
          voucherIds.map((id) => sql`${id}`),
          sql`, `
        )})`);
      const deleted = await tx.delete(vouchers).where(inArray(vouchers.id, voucherIds)).returning({ id: vouchers.id });
      if (deleted.length !== voucherIds.length) rejectEdit("Voucher deletion was incomplete", "IC_DELETE_PARTIAL");

      await tx.delete(containerCharges).where(eq(containerCharges.containerId, data.physical.id));
      // Existing tracking documents or later container references are
      // protected by FK constraints; abort rather than forcing CASCADE.
      await tx.delete(importLogs).where(eq(importLogs.containerId, data.physical.id));
      await tx.delete(containers).where(eq(containers.id, data.physical.id));

      const remainingBatch = await tx
        .select({ id: intercompanyImportBatchContainers.id })
        .from(intercompanyImportBatchContainers)
        .where(eq(intercompanyImportBatchContainers.batchId, data.imported.batchId))
        .limit(1);
      if (!remainingBatch.length) {
        await tx.delete(intercompanyImportBatches).where(eq(intercompanyImportBatches.id, data.imported.batchId));
      }

      await tx.insert(intercompanyAuditEvents).values({
        eventKey: "ic-linked-physical-delete:" + tradeId,
        relationshipId: data.trade.relationshipId,
        sourceCompanyId: data.trade.sourceCompanyId,
        actorUserId: actor.actorUserId,
        eventType: "linked-po-physically-deleted",
        sourceReference: "trade:" + tradeId,
        payload: {
          destinationCompanyId: data.trade.destinationCompanyId,
          containerNumber: data.physical.containerNumber,
          originalPoIds: data.source.map((group) => group.po.id),
          destinationPoId: data.destination.po.id,
          deletedVoucherIds: voucherIds,
          deletedVoucherNumbers: posted.map((item) => item.voucherNumber),
          landedTotal: data.imported.confirmedLandedCost,
          noReversalVoucherCreated: true,
        },
      });
      await tx.execute(sql`SELECT set_config('erp.ic_physical_delete', '', true)`);
      return {
        deleted: true,
        tradeId,
        containerNumber: data.physical.containerNumber,
        poIds,
        voucherIds,
        companies: [data.trade.sourceCompanyId, data.trade.destinationCompanyId],
      };
    })
  );
}
