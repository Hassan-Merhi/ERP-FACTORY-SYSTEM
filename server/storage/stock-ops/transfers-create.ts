import Decimal from "decimal.js";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db";
import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import type { StockTransferItem, StockAdjustmentItem } from "@shared/schema";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { shouldInsertAdjustmentVoucherEntry } from "./adjustmentVoucherEntryGuard";
import { stockAdjustmentHeaderTotal, stockAdjustmentNetLine } from "./stockAdjustmentTotals";
import { lockInventoryRow } from "../inventoryRowLock";
import { adjustInventory } from "../../inventoryHelper";
import { assertNoBaleMirrorMovementTx } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { syncStockAdjustmentInventoryTx } from "../../services/accounting/perpetualInventory/stockAdjustments";
import { insertInfrastructureVoucherTx } from "../../services/accounting/infrastructureVoucherIdentity";
import type { PostingSourceIdentity } from "../../services/accounting/centralPostingEngine";
import {
  moveTransferLegConservedTx,
  postTransferResidualTx,
  recordTransferValueMovedTx,
  transferVoucherDateTx,
} from "../../services/inventory/conservedStockTransfer";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

/**
 * A second stock adjustment was created for a voucher that already had one.
 *
 * The route checks for this before it calls in, but a check made in one
 * connection and an insert made in another are two separate moments: two
 * submissions arriving together both find nothing and both apply their items to
 * inventory. The check below is made under a lock on the voucher row inside the
 * same transaction as the insert, so the second one loses.
 */
export class DuplicateStockAdjustmentError extends Error {
  readonly code = "STOCK_ADJUSTMENT_ALREADY_EXISTS";

  constructor(voucherId: number) {
    super(`Voucher ${voucherId} already has a stock adjustment`);
    this.name = "DuplicateStockAdjustmentError";
  }
}

/**
 * A second stock transfer document was created for a voucher that already had
 * one. The endpoint that attaches items to an existing voucher had no guard at
 * all: submitting it twice built a second transfer and moved the stock again.
 */
export class DuplicateStockTransferError extends Error {
  readonly code = "STOCK_TRANSFER_ALREADY_EXISTS";

  constructor(voucherId: number) {
    super(`Voucher ${voucherId} already has a stock transfer`);
    this.name = "DuplicateStockTransferError";
  }
}

export class StockTransferPolicyError extends Error {
  constructor(
    readonly code: "STOCK_TRANSFER_SCOPE_INVALID" | "STOCK_TRANSFER_NEGATIVE_STOCK_DISABLED",
    message: string
  ) {
    super(message);
    this.name = "StockTransferPolicyError";
  }
}

type TransferMovementItem = {
  sourceLocationId: number;
  stockItemId: number;
  quantity: string;
  rate: string;
};

function groupTransferMovementItems(items: TransferMovementItem[]): TransferMovementItem[] {
  const grouped = new Map<
    string,
    {
      sourceLocationId: number;
      stockItemId: number;
      quantity: ReturnType<typeof toInventoryDecimal>;
      value: ReturnType<typeof toInventoryDecimal>;
    }
  >();

  for (const item of items) {
    const quantity = toInventoryDecimal(item.quantity);
    const rate = toInventoryDecimal(item.rate);
    const key = `${item.sourceLocationId}:${item.stockItemId}`;
    const existing = grouped.get(key);
    const value = multiplyInventoryValues(quantity, rate);
    if (existing) {
      existing.quantity = addInventoryValues(existing.quantity, quantity);
      existing.value = addInventoryValues(existing.value, value);
    } else {
      grouped.set(key, {
        sourceLocationId: item.sourceLocationId,
        stockItemId: item.stockItemId,
        quantity,
        value,
      });
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId)
    .map((item) => ({
      sourceLocationId: item.sourceLocationId,
      stockItemId: item.stockItemId,
      quantity: inventoryQuantity(item.quantity),
      rate: inventoryUnitCost(item.quantity.isZero() ? toInventoryDecimal(0) : item.value.dividedBy(item.quantity)),
    }));
}

export async function assertTransferCompanyScopeTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  destinationLocationId: number,
  items: TransferMovementItem[]
): Promise<void> {
  const locationIds = Array.from(new Set([destinationLocationId, ...items.map((item) => item.sourceLocationId)]));
  const validLocations = await tx
    .select({ id: schema.locations.id })
    .from(schema.locations)
    .where(
      and(
        eq(schema.locations.companyId, companyId),
        inArray(schema.locations.id, locationIds),
        isNull(schema.locations.deletedAt)
      )
    );
  if (validLocations.length !== locationIds.length) {
    throw new StockTransferPolicyError(
      "STOCK_TRANSFER_SCOPE_INVALID",
      "One or more transfer locations do not belong to the active company"
    );
  }

  const stockItemIds = Array.from(new Set(items.map((item) => item.stockItemId)));
  const validItems = await tx
    .select({ id: schema.stockItems.id })
    .from(schema.stockItems)
    .where(
      and(
        eq(schema.stockItems.companyId, companyId),
        inArray(schema.stockItems.id, stockItemIds),
        isNull(schema.stockItems.deletedAt)
      )
    );
  if (validItems.length !== stockItemIds.length) {
    throw new StockTransferPolicyError(
      "STOCK_TRANSFER_SCOPE_INVALID",
      "One or more stock items do not belong to the active company"
    );
  }
}

/**
 * Canonical stock-transfer movement path shared by both create routes.
 *
 * Every existing inventory row is locked before the first mutation. A missing
 * source is treated as a zero balance: it can become a negative row only when
 * the caller explicitly permits negative stock, otherwise the whole transaction
 * is rejected before either side changes.
 */
export async function applyStockTransferInventoryTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    companyId: number;
    transferId: number;
    sourceVoucherId: number;
    destinationLocationId: number;
    items: TransferMovementItem[];
    allowNegativeInventory: boolean;
  }
): Promise<void> {
  const movementItems = groupTransferMovementItems(input.items);
  await assertTransferCompanyScopeTx(tx, input.companyId, input.destinationLocationId, movementItems);
  // Wave 11: a factory bale-mirror item is moved in the factory after the cut-over.
  await assertNoBaleMirrorMovementTx(
    tx,
    input.companyId,
    movementItems.map((item) => item.stockItemId),
    "stock-transfer"
  );

  const lockKeys = new Map<string, { locationId: number; stockItemId: number }>();
  for (const item of movementItems) {
    lockKeys.set(`${item.sourceLocationId}:${item.stockItemId}`, {
      locationId: item.sourceLocationId,
      stockItemId: item.stockItemId,
    });
    lockKeys.set(`${input.destinationLocationId}:${item.stockItemId}`, {
      locationId: input.destinationLocationId,
      stockItemId: item.stockItemId,
    });
  }

  const lockedRows = new Map<string, Awaited<ReturnType<typeof lockInventoryRow>>>();
  const orderedLocks = Array.from(lockKeys.values()).sort(
    (a, b) => a.locationId - b.locationId || a.stockItemId - b.stockItemId
  );
  for (const key of orderedLocks) {
    lockedRows.set(`${key.locationId}:${key.stockItemId}`, await lockInventoryRow(tx, key.locationId, key.stockItemId));
  }

  if (!input.allowNegativeInventory) {
    for (const item of movementItems) {
      const source = lockedRows.get(`${item.sourceLocationId}:${item.stockItemId}`);
      const available = toInventoryDecimal(source?.quantity ?? "0");
      const required = toInventoryDecimal(item.quantity);
      if (available.lessThan(required)) {
        throw new StockTransferPolicyError(
          "STOCK_TRANSFER_NEGATIVE_STOCK_DISABLED",
          `Location ${item.sourceLocationId} has ${inventoryQuantity(available)} available for stock item ${item.stockItemId}, but ${inventoryQuantity(required)} is required`
        );
      }
    }
  }

  // Wave 11: the destination receives exactly the value the source relieved,
  // and each line records it as value_moved (see conservedStockTransfer).
  const relievedByGroup = new Map<string, Decimal>();
  const deltas: Decimal[] = [];
  for (const item of movementItems) {
    const quantity = toInventoryDecimal(item.quantity);
    const rate = toInventoryDecimal(item.rate);

    const sourceWasMissing = !lockedRows.get(`${item.sourceLocationId}:${item.stockItemId}`);

    // The transfer's historical rate is only the cost memory of a source that
    // has no row (the negative layer's provisional rate); the destination is
    // valued at what the source relieved.
    const moved = await moveTransferLegConservedTx(tx, {
      companyId: input.companyId,
      sourceLocationId: item.sourceLocationId,
      destinationLocationId: input.destinationLocationId,
      stockItemId: item.stockItemId,
      quantity,
      fallbackRate: rate,
      sourceVoucherType: "Stock Transfer",
      sourceVoucherId: input.sourceVoucherId,
    });
    relievedByGroup.set(`${item.sourceLocationId}:${item.stockItemId}`, moved.relieved);
    deltas.push(moved.sourceDelta, moved.destinationDelta);
    // Wave 15 (H3): a source with no row goes short at the transfer's rate
    // and keeps that negative value (negative-stock policy), exactly what the
    // destination received. It used to be reset to zero after the move, which
    // left the destination's value standing on nothing: value created from a
    // transfer, with no journal.

    await postStockMovementTx(
      tx,
      {
        companyId: input.companyId,
        stockItemId: item.stockItemId,
        kind: "transfer",
        quantity: inventoryQuantity(quantity),
        unitCost: inventoryUnitCost(sourceWasMissing ? rate : moved.rate),
        fromLocationId: item.sourceLocationId,
        toLocationId: input.destinationLocationId,
        occurredAt: new Date().toISOString(),
        source: {
          sourceType: "stock-transfer",
          sourceId: String(input.transferId),
          idempotencyKey: `stock-transfer:${input.transferId}:${item.stockItemId}:${item.sourceLocationId}:${input.destinationLocationId}`,
        },
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  }
  await recordTransferValueMovedTx(tx, input.transferId, relievedByGroup);
  await postTransferResidualTx(tx, {
    companyId: input.companyId,
    transferId: input.transferId,
    date: await transferVoucherDateTx(tx, input.companyId, input.sourceVoucherId),
    reference: `Transfer ${input.transferId}`,
    deltas,
  });
}

export async function createStockTransfer(
  voucherId: number,
  destinationLocationId: number,
  notes: string,
  items: TransferMovementItem[],
  options: { allowNegativeInventory?: boolean; activeCompanyId?: number } = {}
) {
  return await db.transaction(async (tx) => {
    // The lock makes the duplicate check below decisive: two submissions for the
    // same voucher are ordered, and the second one finds the first one's row.
    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId)).for("update");
    if (!voucher) throw new Error(`Voucher ${voucherId} not found`);
    if (options.activeCompanyId !== undefined && voucher.companyId !== options.activeCompanyId) {
      throw new StockTransferPolicyError("STOCK_TRANSFER_SCOPE_INVALID", "Voucher belongs to a different company");
    }
    const isOptional = voucher.optional;

    const [duplicate] = await tx
      .select({ id: schema.stockTransferVouchers.id })
      .from(schema.stockTransferVouchers)
      .where(eq(schema.stockTransferVouchers.voucherId, voucherId))
      .limit(1);
    if (duplicate) throw new DuplicateStockTransferError(voucherId);

    if (!items || items.length === 0) throw new Error("No items provided for stock transfer");

    const sortedTransferItems = [...items].sort(
      (a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId
    );

    // Resolve historical transfer cost from the locked source row whenever it
    // exists. The browser can display/submit a rounded rate, but that must not
    // become the accounting source of truth. A genuinely missing source has no
    // inventory cost to read, so its submitted rate is retained as the cost
    // memory used when an explicitly permitted negative row is created.
    const costedTransferItems: TransferMovementItem[] = [];
    for (const item of sortedTransferItems) {
      const sourceInventory = await lockInventoryRow(tx, item.sourceLocationId, item.stockItemId);
      costedTransferItems.push({
        ...item,
        rate: String(sourceInventory?.average_rate ?? item.rate ?? "0"),
      });
    }

    // Validate tenant ownership before writing the transfer header. This is
    // repeated by the movement helper immediately before applying stock so both
    // document-only (optional) and posted transfers share the same boundary.
    await assertTransferCompanyScopeTx(tx, voucher.companyId, destinationLocationId, costedTransferItems);

    const [transfer] = await tx
      .insert(schema.stockTransferVouchers)
      .values({
        voucherId,
        sourceLocationId:
          new Set(costedTransferItems.map((item) => item.sourceLocationId)).size === 1
            ? costedTransferItems[0].sourceLocationId
            : null,
        destinationLocationId,
        notes,
        inventoryApplied: !isOptional,
      })
      .returning();

    const transferItems: StockTransferItem[] = [];
    let totalAmount = toInventoryDecimal(0);
    for (const item of costedTransferItems) {
      const quantity = toInventoryDecimal(item.quantity);
      const rate = toInventoryDecimal(item.rate);
      const lineTotal = multiplyInventoryValues(quantity, rate);
      totalAmount = addInventoryValues(totalAmount, lineTotal);

      const [transferItem] = await tx
        .insert(schema.stockTransferItems)
        .values({
          transferId: transfer.id,
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(rate),
          totalAmount: inventoryMoney(lineTotal),
        })
        .returning();

      transferItems.push(transferItem);
    }

    if (!isOptional) {
      await applyStockTransferInventoryTx(tx, {
        companyId: voucher.companyId,
        transferId: transfer.id,
        sourceVoucherId: voucherId,
        destinationLocationId,
        items: transferItems.map((item) => ({
          sourceLocationId: item.sourceLocationId!,
          stockItemId: item.stockItemId,
          quantity: item.quantity,
          rate: item.rate,
        })),
        // Internal callers historically permitted negative stock. HTTP callers
        // pass the explicit UI policy through options, so this default preserves
        // old storage-level behavior without weakening the route.
        allowNegativeInventory: options.allowNegativeInventory ?? true,
      });
    }

    await tx
      .update(schema.vouchers)
      .set({
        description: notes || null,
        totalAmount: inventoryMoney(totalAmount),
      })
      .where(eq(schema.vouchers.id, voucherId));

    return { transfer, items: transferItems };
  });
}

type StockAdjustmentType = "Production" | "Consumption" | "Mixed";
type StockAdjustmentInputItem = { stockItemId: number; quantity: string; rate: string };

export async function createStockAdjustment(
  voucherId: number,
  locationId: number,
  adjustmentType: StockAdjustmentType,
  notes: string,
  items: StockAdjustmentInputItem[],
  _consumptionAccountOverride?: { code: string; name: string },
  voucherHeader?: { currency?: string; voucherDate?: string; description?: string },
  storedAdjustmentType?: string
) {
  return await db.transaction((tx) =>
    createStockAdjustmentTx(
      tx,
      voucherId,
      locationId,
      adjustmentType,
      notes,
      items,
      voucherHeader,
      storedAdjustmentType
    )
  );
}

/**
 * Creates a stock adjustment voucher and its adjustment in one transaction
 * (wave 12): the stock adjustment writers are the only creators of the stock
 * voucher types, so the voucher, its stock document and its one-sided line
 * commit together and the balance guard sees the stock document that exempts it.
 */
export async function createStockAdjustmentWithVoucher(
  voucher: Omit<schema.InsertVoucher, "voucherType"> & { voucherType: StockAdjustmentType },
  postingSource: PostingSourceIdentity,
  locationId: number,
  notes: string,
  items: StockAdjustmentInputItem[],
  voucherHeader?: { currency?: string }
) {
  return await db.transaction((tx) =>
    createStockAdjustmentWithVoucherTx(tx, voucher, postingSource, locationId, notes, items, voucherHeader)
  );
}

/**
 * createStockAdjustmentWithVoucher in the caller's transaction (wave 15): the
 * waste dispatch writes its dispatch rows in the same transaction as the
 * voucher and its adjustment.
 */
export async function createStockAdjustmentWithVoucherTx(
  tx: DbTransaction,
  voucher: Omit<schema.InsertVoucher, "voucherType"> & { voucherType: StockAdjustmentType },
  postingSource: PostingSourceIdentity,
  locationId: number,
  notes: string,
  items: StockAdjustmentInputItem[],
  voucherHeader?: { currency?: string }
) {
  const { voucher: created } = await insertInfrastructureVoucherTx(tx, voucher, postingSource, voucher);
  const result = await createStockAdjustmentTx(
    tx,
    created.id,
    locationId,
    voucher.voucherType,
    notes,
    items,
    voucherHeader
  );
  const [stored] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, created.id));
  return { ...result, voucher: stored ?? result.voucher };
}

async function createStockAdjustmentTx(
  tx: DbTransaction,
  voucherId: number,
  locationId: number,
  adjustmentType: StockAdjustmentType,
  notes: string,
  items: StockAdjustmentInputItem[],
  voucherHeader?: { currency?: string; voucherDate?: string; description?: string },
  storedAdjustmentType?: string
) {
  {
    // Locking the voucher row serialises everyone who wants to adjust it, so the
    // duplicate check below cannot be overtaken between reading and inserting.
    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId)).for("update");
    if (!voucher) throw new Error(`Voucher ${voucherId} not found`);
    const isOptional = voucher.optional;

    const [duplicate] = await tx
      .select({ id: schema.stockAdjustmentVouchers.id })
      .from(schema.stockAdjustmentVouchers)
      .where(eq(schema.stockAdjustmentVouchers.voucherId, voucherId))
      .limit(1);
    if (duplicate) throw new DuplicateStockAdjustmentError(voucherId);

    const [adjustment] = await tx
      .insert(schema.stockAdjustmentVouchers)
      .values({ voucherId, locationId, adjustmentType: storedAdjustmentType ?? adjustmentType, notes })
      .returning();

    const [location] = await tx.select().from(schema.locations).where(eq(schema.locations.id, locationId));
    if (!location) throw new Error(`Location ${locationId} not found`);

    const findOrCreateAdjustmentAccount = async (
      code: string,
      name: string,
      accountType: string,
      openingBalanceSide: "Dr" | "Cr"
    ): Promise<number> => {
      // System adjustment accounts are unique by (company_id, code). A soft-deleted
      // row still owns that unique key, so filtering deleted rows out and inserting
      // a replacement raises a unique-constraint error. Reuse/reactivate the
      // canonical row instead. The upsert also closes the race where two different
      // vouchers create the system account at the same time.
      let [account] = await tx
        .select()
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.companyId, location.companyId), eq(schema.ledgerAccounts.code, code)))
        .limit(1);

      if (account?.deletedAt || account?.active === false) {
        [account] = await tx
          .update(schema.ledgerAccounts)
          .set({
            name,
            accountType,
            subType: accountType,
            openingBalanceSide,
            active: true,
            isHidden: false,
            deletedAt: null,
          })
          .where(eq(schema.ledgerAccounts.id, account.id))
          .returning();
      }

      if (!account) {
        [account] = await tx
          .insert(schema.ledgerAccounts)
          .values({
            companyId: location.companyId,
            code,
            name,
            accountType,
            subType: accountType,
            openingBalance: "0",
            openingBalanceSide,
          })
          .onConflictDoUpdate({
            target: [schema.ledgerAccounts.companyId, schema.ledgerAccounts.code],
            set: {
              name,
              accountType,
              subType: accountType,
              openingBalanceSide,
              active: true,
              isHidden: false,
              deletedAt: null,
            },
          })
          .returning();
      }
      return account.id;
    };

    // Production and consumption both post to STOCK_ADJUSTMENT.
    let adjustmentAccountId: number | null = null;

    if (!isOptional) {
      adjustmentAccountId = await findOrCreateAdjustmentAccount(
        "STOCK_ADJUSTMENT",
        "Stock Adjustment (Production/Consumption)",
        "Indirect Expense",
        "Dr"
      );
    }

    let totalProductionValue = toInventoryDecimal(0);
    let totalConsumptionValue = toInventoryDecimal(0);

    const sortedAdjItems = [...items].sort((a, b) => a.stockItemId - b.stockItemId);
    const adjustmentItems: StockAdjustmentItem[] = [];
    for (const item of sortedAdjItems) {
      const quantity = toInventoryDecimal(item.quantity);
      const absoluteQuantity = quantity.abs();
      const rate = toInventoryDecimal(item.rate);
      const isProduction = adjustmentType === "Production" || (adjustmentType === "Mixed" && quantity.isPositive());
      let actualRate = rate;
      let actualTotalAmount = multiplyInventoryValues(absoluteQuantity, rate);

      let valueMoved: Decimal | null = null;
      if (!isOptional) {
        // Wave 11: every line moves stock through adjustInventory, so value is
        // inventory.total_value (never rebuilt from the rounded rate), a short
        // row holds no value and keeps a negative layer, and the line records
        // the exact value it moved.
        const currentInventory = await lockInventoryRow(tx, locationId, item.stockItemId);
        let incomingRate: number | undefined = isProduction ? rate.toNumber() : undefined;
        if (!isProduction) {
          if (currentInventory) {
            actualRate = Decimal.max(toInventoryDecimal(currentInventory.average_rate), 0);
          } else {
            const [stockItem] = await tx
              .select()
              .from(schema.stockItems)
              .where(eq(schema.stockItems.id, item.stockItemId));
            if (!stockItem) throw new Error(`Stock item ${item.stockItemId} not found.`);
            const fallbackRate = toInventoryDecimal(stockItem.openingRate);
            if (!fallbackRate.isPositive()) throw new Error(`Stock item "${stockItem.name}" has no opening rate set.`);
            // The opening rate is the provisional cost of the shortage.
            actualRate = fallbackRate;
            incomingRate = fallbackRate.toNumber();
          }
          actualTotalAmount = multiplyInventoryValues(absoluteQuantity, actualRate);
        }
        const moved = await adjustInventory(
          tx,
          locationId,
          item.stockItemId,
          isProduction ? absoluteQuantity.toNumber() : absoluteQuantity.negated().toNumber(),
          location.companyId,
          incomingRate,
          "Stock Adjustment",
          voucherId
        );
        const delta = toInventoryDecimal(moved.valueDelta);
        valueMoved = delta.abs();
        // The voucher's STOCK_ADJUSTMENT lines keep the document value
        // (quantity × rate); syncStockAdjustmentInventoryTx posts Inventory at
        // the recorded value_moved and any difference to INVENTORY_ADJUSTMENT.
        if (isProduction) totalProductionValue = addInventoryValues(totalProductionValue, actualTotalAmount);
        else totalConsumptionValue = addInventoryValues(totalConsumptionValue, actualTotalAmount);
      }

      // Canonical evidence for the applied adjustment, on the same transaction
      // that just moved the inventory above. The rate is the one the adjustment
      // actually resolved — a consumption line takes the location's current
      // average or the item's opening rate, not the rate the caller sent — so
      // the journal records the cost that was really applied.
      //
      // A zero-quantity adjustment changes no stock and gets no movement row:
      // the canonical boundary rejects a zero quantity precisely because it is
      // not a movement.
      if (!isOptional && !absoluteQuantity.isZero()) {
        await postStockMovementTx(
          tx,
          {
            companyId: voucher.companyId,
            stockItemId: item.stockItemId,
            kind: isProduction ? "receipt" : "issue",
            quantity: inventoryQuantity(absoluteQuantity),
            unitCost: inventoryUnitCost(actualRate),
            fromLocationId: isProduction ? null : locationId,
            toLocationId: isProduction ? locationId : null,
            occurredAt: new Date().toISOString(),
            source: {
              sourceType: "stock-adjustment",
              sourceId: String(adjustment.id),
              idempotencyKey: `stock-adjustment:${adjustment.id}:${item.stockItemId}`,
            },
            // The journal records what the adjustment did; it does not add a
            // negative-stock rule the adjustment does not itself enforce.
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }

      const [adjustmentItem] = await tx
        .insert(schema.stockAdjustmentItems)
        .values({
          adjustmentId: adjustment.id,
          stockItemId: item.stockItemId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(actualRate),
          totalAmount: inventoryMoney(actualTotalAmount),
          valueMoved: valueMoved === null ? null : inventoryMoney(valueMoved),
        })
        .returning();
      adjustmentItems.push(adjustmentItem);
    }

    if (!isOptional) {
      // Production and consumption post to the same STOCK_ADJUSTMENT account: one net line.
      const netLine = stockAdjustmentNetLine(totalProductionValue, totalConsumptionValue, adjustmentType);
      const netValue = totalProductionValue.minus(totalConsumptionValue).abs();
      if (netLine && shouldInsertAdjustmentVoucherEntry(netValue, adjustmentAccountId)) {
        await tx.insert(schema.voucherEntries).values({ voucherId, ledgerAccountId: adjustmentAccountId, ...netLine });
      }
    }

    const headerTotal = stockAdjustmentHeaderTotal(adjustmentType, adjustmentItems);
    const [updatedVoucher] = await tx
      .update(schema.vouchers)
      .set({
        totalAmount: headerTotal,
        locationId,
        ...(voucherHeader?.currency ? { currency: voucherHeader.currency } : {}),
        ...(voucherHeader?.description !== undefined ? { description: voucherHeader.description } : {}),
        ...(voucherHeader?.voucherDate !== undefined ? { voucherDate: voucherHeader.voucherDate } : {}),
      })
      .where(eq(schema.vouchers.id, voucherId))
      .returning();

    if (!updatedVoucher) throw new Error(`Voucher ${voucherId} not found`);

    // Perpetual inventory (wave 8.3): the voucher carries the inventory side of the adjustment.
    await syncStockAdjustmentInventoryTx(tx, voucher.companyId, voucherId);

    return { adjustment, items: adjustmentItems, voucher: updatedVoucher };
  }
}
