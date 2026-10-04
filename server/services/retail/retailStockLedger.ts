import { and, eq, sql } from "drizzle-orm";
import { retailStockMovements, retailVariantInventory } from "@shared/schema";
import { db } from "../../db";

export type RetailTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Creates (if needed) and row-locks the stock row for one variant at one location.
 * Every retail stock write goes through this so sales, returns, transfers,
 * receipts and adjustments serialize on the exact variant + location.
 */
export async function lockInventoryRow(
  tx: RetailTransaction,
  companyId: number,
  variantId: number,
  locationId: number
): Promise<{ quantity: number; averageCost: number }> {
  await tx
    .insert(retailVariantInventory)
    .values({ companyId, variantId, locationId, quantity: "0", averageCost: "0" })
    .onConflictDoNothing({ target: [retailVariantInventory.variantId, retailVariantInventory.locationId] });

  await tx.execute(
    sql`select id from retail_variant_inventory where company_id = ${companyId} and variant_id = ${variantId} and location_id = ${locationId} for update`
  );

  const [inventory] = await tx
    .select({ quantity: retailVariantInventory.quantity, averageCost: retailVariantInventory.averageCost })
    .from(retailVariantInventory)
    .where(
      and(
        eq(retailVariantInventory.companyId, companyId),
        eq(retailVariantInventory.variantId, variantId),
        eq(retailVariantInventory.locationId, locationId)
      )
    )
    .limit(1);

  if (!inventory) throw new Error("Retail inventory row could not be created");
  return { quantity: toNumber(inventory.quantity), averageCost: toNumber(inventory.averageCost) };
}

export async function setInventoryQuantity(
  tx: RetailTransaction,
  companyId: number,
  variantId: number,
  locationId: number,
  quantity: number,
  averageCost?: number
): Promise<void> {
  await tx
    .update(retailVariantInventory)
    .set({
      quantity: String(quantity),
      ...(averageCost === undefined ? {} : { averageCost: String(averageCost) }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(retailVariantInventory.companyId, companyId),
        eq(retailVariantInventory.variantId, variantId),
        eq(retailVariantInventory.locationId, locationId)
      )
    );
}

/** Weighted average cost after receiving `quantity` units at `unitCost`. */
export function nextAverageCost(
  beforeQuantity: number,
  beforeAverage: number,
  quantity: number,
  unitCost: number
): number {
  const base = Math.max(0, beforeQuantity);
  if (base + quantity <= 0) return unitCost;
  if (base <= 0 || beforeAverage <= 0) return unitCost;
  return (base * beforeAverage + quantity * unitCost) / (base + quantity);
}

export async function addMovement(
  tx: RetailTransaction,
  input: {
    companyId: number;
    variantId: number;
    locationId: number;
    movementType: string;
    quantityDelta: number;
    before: number;
    after: number;
    eventKey: string;
    referenceType?: string;
    referenceId?: string | number;
    createdBy: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.insert(retailStockMovements).values({
    companyId: input.companyId,
    variantId: input.variantId,
    locationId: input.locationId,
    movementType: input.movementType,
    quantityDelta: String(input.quantityDelta),
    quantityBefore: String(input.before),
    quantityAfter: String(input.after),
    eventKey: input.eventKey,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId == null ? null : String(input.referenceId),
    createdBy: input.createdBy,
    metadata: input.metadata ?? {},
  });
}
