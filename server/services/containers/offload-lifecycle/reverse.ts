import Decimal from "decimal.js";
import type { DbTransaction } from "../../../db";
import { and, eq, sql } from "drizzle-orm";
import { reverseInventoryByExactValue } from "../../../inventoryHelper";
import * as schema from "@shared/schema";
import { retireVouchersTx } from "../../accounting/voucherRetirement";
import { createDatabaseStockMovementAdapter } from "../../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../inventory/stockMovementIntegrityService";

import { MoneyDecimal, toMoney } from "../../../lib/money";

import { buildItemMap } from "./types";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

async function deleteVoucherWithEntries(tx: DbTransaction, companyId: number, voucherId: number): Promise<void> {
  // Wave 16 (A): retired — soft-deleted with its lines, audited, its number and
  // durable posting identity released together, so a later re-offload posts a
  // new identity generation instead of replaying the old marker.
  await retireVouchersTx(tx, { companyId, voucherIds: [voucherId], reason: "container-offload-reversed" });
}

/**
 * Reverses an offload's stock and removes its vouchers and record. Returns the
 * signed change of the stock sub-ledger it made (the sum of the reversals'
 * valueDelta), for the pre-cut-over movement journal (wave 15, C1).
 */
export async function reverseExistingOffload(
  tx: DbTransaction,
  container: typeof schema.containers.$inferSelect,
  existingOffload: typeof schema.containerOffloads.$inferSelect,
  lineItems: Array<{ stockItemId: number; quantity: string; rate: string }>
): Promise<Decimal> {
  let subLedgerDelta: Decimal = new MoneyDecimal(0);
  const storedItems = await tx
    .select()
    .from(schema.containerOffloadItems)
    .where(eq(schema.containerOffloadItems.offloadId, existingOffload.id));
  const occurredAt = new Date().toISOString();

  // The stock comes back out at exactly the value the offload moved into the
  // sub-ledger (value_moved; the line value on a legacy line), so the
  // sub-ledger and the stock-in journal (removed with the offload) agree.
  // The company is passed so a reversal that takes the row short records its
  // negative layer.
  if (storedItems.length > 0) {
    for (const item of storedItems) {
      const quantity = toMoney(item.quantity);
      const totalValue = toMoney(item.valueMoved ?? item.totalValue);
      const reversed = await reverseInventoryByExactValue(
        tx,
        existingOffload.locationId,
        item.stockItemId,
        quantity.toNumber(),
        totalValue.toFixed(2),
        container.companyId,
        `container-offload-reverse:${existingOffload.id}`
      );
      if (reversed) subLedgerDelta = subLedgerDelta.plus(toMoney(reversed.valueDelta));
      await postStockMovementTx(
        tx,
        {
          companyId: container.companyId,
          stockItemId: item.stockItemId,
          kind: "adjustment",
          quantity: quantity.toString(),
          unitCost: quantity.gt(0) ? Decimal.max(totalValue.dividedBy(quantity), 0).toDecimalPlaces(6).toString() : "0",
          fromLocationId: existingOffload.locationId,
          occurredAt,
          source: {
            sourceType: "container_offload_reverse",
            sourceId: String(existingOffload.id),
            idempotencyKey: `container-offload-reverse:${container.companyId}:${existingOffload.id}:${item.id}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  } else {
    const legacyAdditionalCost = toMoney(existingOffload.additionalCostPerBale);
    const legacyItems = buildItemMap(lineItems);
    for (const [stockItemId, item] of legacyItems) {
      const estimatedValue = item.weightedRateSum
        .plus(item.totalQuantity.times(legacyAdditionalCost))
        .toDecimalPlaces(2);
      const reversed = await reverseInventoryByExactValue(
        tx,
        existingOffload.locationId,
        stockItemId,
        item.totalQuantity.toNumber(),
        estimatedValue.toFixed(2),
        container.companyId,
        `container-offload-reverse:${existingOffload.id}`
      );
      if (reversed) subLedgerDelta = subLedgerDelta.plus(toMoney(reversed.valueDelta));
      await postStockMovementTx(
        tx,
        {
          companyId: container.companyId,
          stockItemId,
          kind: "adjustment",
          quantity: item.totalQuantity.toString(),
          unitCost: item.totalQuantity.gt(0)
            ? Decimal.max(estimatedValue.dividedBy(item.totalQuantity), 0).toDecimalPlaces(6).toString()
            : "0",
          fromLocationId: existingOffload.locationId,
          occurredAt,
          source: {
            sourceType: "container_offload_reverse_legacy",
            sourceId: String(existingOffload.id),
            idempotencyKey: `container-offload-reverse:legacy:${container.companyId}:${existingOffload.id}:${stockItemId}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  }

  await tx.delete(schema.containerOffloadItems).where(eq(schema.containerOffloadItems.offloadId, existingOffload.id));

  const containerPattern = `%container ${container.containerNumber}%`;
  const localVouchers = await tx
    .select({ id: schema.vouchers.id })
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, container.companyId),
        sql`(
          (
            LOWER(${schema.vouchers.description}) LIKE LOWER(${containerPattern})
            AND (
              ${schema.vouchers.voucherNumber} LIKE 'DUTY-%' OR
              ${schema.vouchers.voucherNumber} LIKE 'OFFICE-%' OR
              ${schema.vouchers.voucherNumber} LIKE 'TRANS-%' OR
              ${schema.vouchers.voucherNumber} LIKE 'CHG-%' OR
              ${schema.vouchers.voucherNumber} LIKE 'XFER-%'
            )
          )
          OR ${schema.vouchers.voucherNumber} LIKE ${`SP-OTW-REV-ERP-${container.id}-%`}
          OR ${schema.vouchers.voucherNumber} LIKE ${`SP-STOCK-ERP-${container.id}-%`}
          OR ${schema.vouchers.voucherNumber} LIKE ${`SP-AGENT-SETTLE-${container.id}-%`}
        )`
      )
    );

  for (const voucher of localVouchers) {
    await deleteVoucherWithEntries(tx, container.companyId, voucher.id);
  }

  const parentAgentVouchers = await tx
    .select({ id: schema.vouchers.id })
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, 1),
        sql`${schema.vouchers.voucherNumber} LIKE ${`SP-AGENT-ERP-${container.id}-%`}`
      )
    );
  for (const voucher of parentAgentVouchers) {
    await deleteVoucherWithEntries(tx, 1, voucher.id);
  }

  await tx.delete(schema.containerOffloads).where(eq(schema.containerOffloads.id, existingOffload.id));
  return subLedgerDelta;
}
