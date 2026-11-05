/** Phase 5: receive linked goods into the destination ERP, never into Properties stock. */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  containerOffloads,
  intercompanyAuditEvents,
  intercompanyDestinationReceiptItems,
  intercompanyDestinationReceipts,
  inventory,
  ledgerAccounts,
  locations,
  stockItems,
} from "@shared/schema";
import { db } from "../../db";
import { receiveInventoryAtValue } from "../../inventoryHelper";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { createDatabaseStockMovementAdapter } from "../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../inventory/stockMovementIntegrityService";
import { INTERCOMPANY_PAYMENT_LOCK_NAMESPACE } from "./paymentAllocationCore";
import { assertPhase5MirroredLines } from "./phase5LinkedLineGuard";
import { allocateByWeights, cents, exactPositiveQuantity, requireCostEqual } from "./tradeRevisionMath";
import {
  assertTradeAccess,
  loadTradeTx,
  postingDay,
  rejectEdit,
  requireUnreceived,
  type EditIdentity,
  validateRequestKey,
  withTradeScope,
} from "./tradeSync";

export type ReceiveIntercompanyTradeInput = {
  tradeId: number;
  expectedVersion: number;
  requestKey: string;
  postingDate: string;
  locationId: number;
  inventoryAccountId: number;
  arrivalEvidence: string;
  reason: string;
  confirmPhysicalArrival: boolean;
  confirmNoAdditionalUnpostedCharges: boolean;
};

export function receiptFingerprint(input: ReceiveIntercompanyTradeInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tradeId: input.tradeId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        postingDate: input.postingDate,
        locationId: input.locationId,
        inventoryAccountId: input.inventoryAccountId,
        arrivalEvidence: input.arrivalEvidence.trim(),
        reason: input.reason.trim(),
        confirmPhysicalArrival: input.confirmPhysicalArrival,
        confirmNoAdditionalUnpostedCharges: input.confirmNoAdditionalUnpostedCharges,
      })
    )
    .digest("hex");
}

export type Phase5ReceivedStockLine = { stockItemId: number; quantity: string; value: string };
/** One verified receiving company's PO lines: allocate the FULL landed amount without inventing cents. */
export function exactDestinationReceiptPlan(
  lines: ReadonlyArray<{
    stockItemId: number;
    quantity: string;
    lineTotal: string;
  }>,
  expectedGoods: string,
  landedCost: string
): Phase5ReceivedStockLine[] {
  if (!lines.length || lines.length > 3000) throw new Error("Verified destination purchase lines are missing");
  const group = new Map<number, { qty: ReturnType<typeof exactPositiveQuantity>; goods: ReturnType<typeof cents> }>();
  let totalGoods = new MoneyDecimal(0);
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.stockItemId) ||
      line.stockItemId < 1 ||
      !/^\d+(?:\.\d{1,2})?$/.test(line.lineTotal)
    ) {
      throw new Error("A destination PO line lacks verified stock identity or exact USD value");
    }
    const qty = exactPositiveQuantity(line.quantity);
    const goods = cents(line.lineTotal);
    if (goods.lt(0)) throw new Error("Destination PO contains negative goods value");
    const prior = group.get(line.stockItemId);
    group.set(line.stockItemId, {
      qty: (prior?.qty ?? new MoneyDecimal(0)).plus(qty),
      goods: (prior?.goods ?? new MoneyDecimal(0)).plus(goods),
    });
    totalGoods = totalGoods.plus(goods);
  }
  requireCostEqual("Destination PO goods", totalGoods, cents(expectedGoods));
  const cost = cents(landedCost);
  if (!cost.gt(0) || totalGoods.lte(0)) throw new Error("Confirmed landed cost and goods must be positive");
  const sorted = [...group.entries()].sort((a, b) => a[0] - b[0]);
  const amounts = allocateByWeights(
    cost,
    sorted.map((row) => row[1].goods)
  );
  requireCostEqual("Receipt cost allocation", sumMoney(amounts), cost);
  return sorted.map(([stockItemId, totals], i) => ({
    stockItemId,
    quantity: totals.qty.toFixed(3),
    value: amounts[i].toFixed(2),
  }));
}

export async function receiveLinkedTrade(input: ReceiveIntercompanyTradeInput, actor: EditIdentity) {
  postingDay(input.postingDate);
  validateRequestKey(input.requestKey);
  if (
    !Number.isSafeInteger(input.tradeId) ||
    input.tradeId < 1 ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !Number.isSafeInteger(input.locationId) ||
    input.locationId < 1 ||
    !Number.isSafeInteger(input.inventoryAccountId) ||
    input.inventoryAccountId < 1 ||
    !input.confirmPhysicalArrival ||
    !input.confirmNoAdditionalUnpostedCharges ||
    !input.arrivalEvidence?.trim() ||
    input.arrivalEvidence.trim().length < 8 ||
    input.arrivalEvidence.length > 2000 ||
    !input.reason?.trim() ||
    input.reason.trim().length < 3 ||
    input.reason.length > 1000
  ) {
    rejectEdit(
      "A confirmed ERP destination/location, final landed cost and physical-arrival evidence are required",
      "IC_RECEIPT_INPUT",
      422
    );
  }
  const fingerprint = receiptFingerprint(input);
  const trade = await assertTradeAccess(input.tradeId, actor);
  if (actor.initiatingCompanyId !== trade.destinationCompanyId) {
    rejectEdit(
      "Receive destination inventory only while signed into the receiving ERP company",
      "IC_RECEIPT_COMPANY",
      403
    );
  }
  return withTradeScope(actor, [trade.sourceCompanyId], () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          "SELECT pg_advisory_xact_lock(" + INTERCOMPANY_PAYMENT_LOCK_NAMESPACE + "," + trade.sourceCompanyId + ")"
        )
      );
      const [record] = await tx
        .select()
        .from(intercompanyDestinationReceipts)
        .where(eq(intercompanyDestinationReceipts.tradeId, input.tradeId));
      if (record) {
        if (record.requestKey !== input.requestKey || record.requestFingerprint !== fingerprint) {
          rejectEdit(
            "Container was already received; a second offload or modified replay is forbidden",
            "IC_RECEIPT_REPLAY"
          );
        }
        return { receiptId: record.id, tradeId: input.tradeId, landedCost: record.landedCost, replayed: true };
      }
      const data = await loadTradeTx(tx, input.tradeId);
      if (data.trade.version !== input.expectedVersion) {
        rejectEdit("Linked purchase order changed; reload the confirmed landed cost", "IC_RECEIPT_STALE");
      }
      requireUnreceived(data);
      if (!data.policy.tradeEnabled)
        rejectEdit("Trading relationship was disabled before receipt", "IC_RECEIPT_DISABLED");
      const [existingOffload] = await tx
        .select({ id: containerOffloads.id })
        .from(containerOffloads)
        .where(eq(containerOffloads.containerId, data.physical.id));
      if (existingOffload) rejectEdit("Existing legacy offload conflicts with a linked destination receipt");
      const [location] = await tx
        .select()
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.companyId, data.trade.destinationCompanyId),
            eq(locations.active, true),
            isNull(locations.deletedAt)
          )
        );
      if (!location)
        rejectEdit("Destination warehouse must be active and belong to the receiving company", "IC_RECEIPT_LOCATION");
      const [account] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.id, input.inventoryAccountId),
            eq(ledgerAccounts.companyId, data.trade.destinationCompanyId),
            eq(ledgerAccounts.active, true),
            eq(ledgerAccounts.code, "INVENTORY"),
            isNull(ledgerAccounts.deletedAt)
          )
        );
      if (
        !account ||
        !["Asset", "Current Asset"].includes(account.accountType) ||
        input.inventoryAccountId === data.policy.destinationGitAccountId
      ) {
        rejectEdit(
          "Select an existing active ERP INVENTORY asset account distinct from Goods in Transit",
          "IC_RECEIPT_INVENTORY_ACCOUNT"
        );
      }
      assertPhase5MirroredLines(
        data.source.flatMap((group) => group.lines),
        data.destination.lines,
        data.links
      );
      const rows = exactDestinationReceiptPlan(
        data.destination.lines,
        data.destination.po.itemsTotal ?? "0",
        data.imported.confirmedLandedCost ?? "0"
      );
      const items = await tx
        .select()
        .from(stockItems)
        .where(
          inArray(
            stockItems.id,
            rows.map((row) => row.stockItemId)
          )
        );
      if (items.length !== rows.length || items.some((item) => item.companyId !== data.trade.destinationCompanyId)) {
        rejectEdit("Every destination stock item must be owned by the receiving ERP company", "IC_RECEIPT_STOCK_SCOPE");
      }
      // Refuse negative or zero-unit residual inventory: receiving it would
      // settle historical shortage/COGS and needs a separate reviewed correction.
      const current = await tx
        .select()
        .from(inventory)
        .where(
          and(
            eq(inventory.locationId, input.locationId),
            inArray(
              inventory.stockItemId,
              rows.map((row) => row.stockItemId)
            )
          )
        )
        .for("update");
      if (
        current.some(
          (row) =>
            row.companyId !== data.trade.destinationCompanyId ||
            toMoney(row.quantity).lt(0) ||
            (toMoney(row.quantity).isZero() && !cents(row.totalValue).isZero())
        )
      ) {
        rejectEdit(
          "Destination stock has a shortage or residual cost requiring independent COGS review",
          "IC_RECEIPT_STOCK_VARIANCE"
        );
      }
      const value = cents(data.imported.confirmedLandedCost ?? "0").toFixed(2);
      const voucher = await postErpVoucherTx(tx, {
        companyId: data.trade.destinationCompanyId,
        voucherType: "Journal",
        voucherDate: input.postingDate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Receive canonical linked container " + data.physical.containerNumber + " into ERP stock",
        source: { type: "ic-phase5-destination-receipt", id: data.trade.id },
        actor: { userId: actor.actorUserId, reason: input.reason.trim() },
        lines: [
          { ledgerAccountId: account.id, debit: value, narration: "Confirmed inventory received" },
          {
            ledgerAccountId: data.policy.destinationGitAccountId!,
            credit: value,
            narration: "Release same goods from GIT",
          },
        ],
      });
      const [receipt] = await tx
        .insert(intercompanyDestinationReceipts)
        .values({
          tradeId: data.trade.id,
          relationshipId: data.trade.relationshipId,
          destinationCompanyId: data.trade.destinationCompanyId,
          locationId: input.locationId,
          inventoryAccountId: account.id,
          gitAccountId: data.policy.destinationGitAccountId!,
          receiptVoucherId: voucher.voucher.id,
          requestKey: input.requestKey,
          requestFingerprint: fingerprint,
          postingDate: input.postingDate,
          landedCost: value,
          arrivalEvidence: input.arrivalEvidence.trim(),
          reason: input.reason.trim(),
          actorUserId: actor.actorUserId,
        })
        .returning();
      const adapter = createDatabaseStockMovementAdapter();
      const occurredAt = input.postingDate + "T12:00:00.000Z";
      for (const row of rows) {
        const received = await receiveInventoryAtValue(tx, {
          locationId: input.locationId,
          stockItemId: row.stockItemId,
          quantity: row.quantity,
          value: row.value,
          companyId: data.trade.destinationCompanyId,
          sourceVoucherType: "intercompany-destination-receipt",
          sourceVoucherId: voucher.voucher.id,
        });
        if (!cents(received.valueDelta).eq(cents(row.value)) || !cents(received.shortageSettlementVariance).isZero()) {
          rejectEdit(
            "Receipt inventory value differs from the verified GIT cost; transaction rolled back",
            "IC_RECEIPT_STOCK_VARIANCE"
          );
        }
        const movement = await postStockMovementTx(
          tx,
          {
            companyId: data.trade.destinationCompanyId,
            stockItemId: row.stockItemId,
            kind: "receipt",
            quantity: row.quantity,
            unitCost: cents(row.value).div(row.quantity).toFixed(6),
            toLocationId: input.locationId,
            occurredAt,
            source: {
              sourceType: "intercompany-destination-receipt",
              sourceId: String(data.trade.id),
              idempotencyKey: "ic-destination-receipt:" + data.trade.id + ":" + row.stockItemId,
            },
            actor: { userId: actor.actorUserId, reason: input.reason.trim() },
            allowNegativeStock: false,
          },
          adapter
        );
        if (!cents(movement.value).eq(cents(row.value))) {
          rejectEdit(
            "Canonical stock movement value does not match actual ERP inventory receipt",
            "IC_RECEIPT_CANONICAL_VALUE"
          );
        }
        if (movement.idempotent || movement.movements.length !== 1) {
          rejectEdit("Duplicated or incomplete canonical destination stock receipt", "IC_RECEIPT_REPLAY");
        }
        await tx.insert(intercompanyDestinationReceiptItems).values({
          receiptId: receipt.id,
          stockItemId: row.stockItemId,
          quantity: row.quantity,
          landedValue: row.value,
          valueMoved: cents(received.valueDelta).toFixed(2),
          canonicalMovementId: movement.movements[0].id,
        });
      }
      await tx.insert(intercompanyAuditEvents).values({
        eventKey: "ic-destination-stock-received:" + receipt.id,
        relationshipId: data.trade.relationshipId,
        sourceCompanyId: data.trade.sourceCompanyId,
        actorUserId: actor.actorUserId,
        eventType: "intercompany-destination-stock-received",
        sourceReference: data.physical.containerNumber,
        payload: {
          tradeId: data.trade.id,
          destinationCompanyId: data.trade.destinationCompanyId,
          canonicalContainerId: data.physical.id,
          locationId: input.locationId,
          voucherId: voucher.voucher.id,
          landedCost: value,
          receivedLines: rows,
          noPropertiesStockCreated: true,
          noCashOrSupplierVoucherPosted: true,
          arrivalEvidence: input.arrivalEvidence.trim(),
        },
      });
      return { receiptId: receipt.id, tradeId: data.trade.id, landedCost: value, replayed: false };
    })
  );
}
