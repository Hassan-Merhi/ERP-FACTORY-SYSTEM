import { and, eq, sql } from "drizzle-orm";
import { retailVariantInventory, type RetailProductWrite } from "@shared/schema";
import { retailStockMovements } from "@shared/schema/retailPos";
import { db } from "../../db";
import { trackRetailStockValueTx } from "./retailInventoryJournal";

type RetailTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const asNumber = (value: unknown) => Number(value ?? 0);

export class RetailStockConflictError extends Error {
  readonly status = 409;
}

export async function writeVariantInventoryWithMovement(
  tx: RetailTransaction,
  input: {
    companyId: number;
    variantId: number;
    cost: number;
    stocks: RetailProductWrite["variants"][number]["stocks"];
    createdBy: string;
    referenceType: "retail_product_create" | "retail_product_edit";
    referenceId: string;
    eventPrefix: string;
  }
) {
  // Lock the variant's stock rows so a concurrent POS sale cannot interleave
  // between reading the current quantity and writing the edited one.
  await tx.execute(
    sql`select id from retail_variant_inventory where company_id = ${input.companyId} and variant_id = ${input.variantId} order by location_id for update`
  );
  const existingRows = await tx
    .select({ locationId: retailVariantInventory.locationId, quantity: retailVariantInventory.quantity })
    .from(retailVariantInventory)
    .where(
      and(eq(retailVariantInventory.companyId, input.companyId), eq(retailVariantInventory.variantId, input.variantId))
    );
  const existing = new Map(existingRows.map((row) => [row.locationId, asNumber(row.quantity)]));
  const desired = new Map(input.stocks.map((stock) => [stock.locationId, Number(stock.quantity)]));
  for (const stock of input.stocks) {
    if (stock.expectedQuantity === undefined) continue;
    const current = existing.get(stock.locationId) ?? 0;
    if (Math.abs(current - Number(stock.expectedQuantity)) > 0.000001) {
      throw new RetailStockConflictError(
        `Stock changed while you were editing (location ${stock.locationId}: now ${current}, expected ${stock.expectedQuantity}). Reload the product and try again.`
      );
    }
  }
  const locationIds = [...new Set([...existing.keys(), ...desired.keys()])].sort((a, b) => a - b);
  // Wave 17 (D): the value set here (quantity and cost) is journalled against
  // RETAIL-INVENTORY-ADJUSTMENT once the Retail inventory opening is applied.
  const stockValue = await trackRetailStockValueTx(
    tx,
    input.companyId,
    locationIds.map((locationId) => ({ variantId: input.variantId, locationId }))
  );

  for (const locationId of locationIds) {
    const before = existing.get(locationId) ?? 0;
    const after = desired.get(locationId) ?? 0;

    await tx
      .insert(retailVariantInventory)
      .values({
        companyId: input.companyId,
        variantId: input.variantId,
        locationId,
        quantity: String(after),
        averageCost: String(input.cost),
      })
      .onConflictDoUpdate({
        target: [retailVariantInventory.variantId, retailVariantInventory.locationId],
        set: { quantity: String(after), averageCost: String(input.cost), updatedAt: new Date() },
      });

    const delta = after - before;
    if (Math.abs(delta) <= 0.000001) continue;

    await tx.insert(retailStockMovements).values({
      companyId: input.companyId,
      variantId: input.variantId,
      locationId,
      movementType: "adjustment",
      quantityDelta: String(delta),
      quantityBefore: String(before),
      quantityAfter: String(after),
      eventKey: `${input.eventPrefix}:${input.variantId}:${locationId}`.slice(0, 255),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      createdBy: input.createdBy,
      metadata: { source: input.referenceType },
    });
  }
  await stockValue.post({
    kind: "product",
    sourceId: `${input.eventPrefix}:${input.variantId}`,
    description: `Retail product stock · product ${input.referenceId} · variant ${input.variantId}`,
    actor: { userId: input.createdBy },
  });
}
