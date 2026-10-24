import type { Express } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { retailProductVariants, retailProducts, retailStockOperations } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { MoneyDecimal } from "../../lib/money";
import { trackRetailStockValueTx } from "../../services/retail/retailInventoryJournal";
import { ensureRetailVariant } from "../../services/retail/retailSaleService";
import {
  addMovement,
  lockInventoryRow,
  nextAverageCost,
  setInventoryQuantity,
} from "../../services/retail/retailStockLedger";
import { retailAllowedLocationIds, retailLocationRefusal } from "./retailLocationAccess";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";

const IN_TRANSIT_ASSET = "RETAIL-IN-TRANSIT";
const idempotency = z.string().trim().min(8).max(191);
const dispatchSchema = z.object({
  idempotencyKey: idempotency,
  variantId: z.coerce.number().int().positive(),
  fromLocationId: z.coerce.number().int().positive(),
  toLocationId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().max(100000),
  notes: z.string().trim().max(1000).optional(),
});
const receiveSchema = z.object({ idempotencyKey: idempotency });
const toNumber = (value: unknown) => Number(value ?? 0);
type TransferMeta = {
  status?: "otw" | "received";
  variantId?: number;
  productName?: string;
  barcode?: string;
  imageUrls?: string[];
  color?: string;
  size?: string;
  fromLocationId?: number;
  toLocationId?: number;
  quantity?: number;
  sourceUnitCost?: string;
  inTransitValue?: string;
  dispatchedAt?: string;
  receivedAt?: string;
  receivedBy?: string;
  receiveIdempotencyKey?: string;
  notes?: string | null;
};

const metadata = (value: Record<string, unknown>): TransferMeta => value as TransferMeta;

/**
 * Deferred stock transfer: "dispatch" removes stock only at source and debits
 * RETAIL-IN-TRANSIT instead of a loss/expense. The distinct "receive" call is
 * required before the destination can sell those units. Both operations post
 * balanced location inventory/in-transit journals within their own transaction.
 *
 * Immediate inter-location transfer remains the original atomic endpoint.
 */
export function registerRetailTransferWorkflowRoutes(app: Express): void {
  app.get("/api/pos/retail/transfers/workflow", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const requested = String(req.query.status ?? "otw");
      if (!["otw", "received", "all"].includes(requested))
        return res.status(400).json({ message: "Invalid transfer status" });
      // Location-restricted users only see shipments leaving or arriving at their stores.
      const allowed = await retailAllowedLocationIds(req, companyId);
      if (allowed && allowed.size === 0) return res.json([]);
      const allowedIds = allowed
        ? sql.join(
            [...allowed].map((id) => sql`${id}`),
            sql`, `
          )
        : null;
      const rows = await db
        .select()
        .from(retailStockOperations)
        .where(
          and(
            eq(retailStockOperations.companyId, companyId),
            eq(retailStockOperations.operationType, "transfer_dispatch"),
            requested === "all" ? undefined : sql`(${retailStockOperations.metadata}->>'status') = ${requested}`,
            allowedIds === null
              ? undefined
              : sql`((${retailStockOperations.metadata}->>'fromLocationId')::int IN (${allowedIds})
                  OR (${retailStockOperations.metadata}->>'toLocationId')::int IN (${allowedIds}))`
          )
        )
        .orderBy(desc(retailStockOperations.createdAt), desc(retailStockOperations.id))
        .limit(250);
      res.json(
        rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          createdBy: row.createdBy,
          ...metadata(row.metadata ?? {}),
        }))
      );
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/retail/transfers/dispatch", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = dispatchSchema.parse(req.body);
      if (body.fromLocationId === body.toLocationId)
        return res.status(400).json({ message: "Choose different locations" });
      // Shipping is done by the source store; the destination confirms receipt separately.
      const locationRefusal = await retailLocationRefusal(req, companyId, [body.fromLocationId]);
      if (locationRefusal)
        return res.status(403).json({ code: "RETAIL_LOCATION_NOT_ASSIGNED", message: locationRefusal });
      await Promise.all([
        ensureCompanyLocation(companyId, body.fromLocationId),
        ensureCompanyLocation(companyId, body.toLocationId),
      ]);
      const actor = currentUserId(req);
      const result = await db.transaction(async (tx) => {
        const variant = await ensureRetailVariant(tx, companyId, body.variantId);
        const [variantPhotos] = await tx
          .select({
            imageUrls: retailProductVariants.imageUrls,
            productImageUrls: retailProducts.imageUrls,
          })
          .from(retailProductVariants)
          .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
          .where(and(eq(retailProductVariants.id, body.variantId), eq(retailProductVariants.companyId, companyId)))
          .limit(1);
        const [created] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "transfer_dispatch",
            idempotencyKey: body.idempotencyKey,
            createdBy: actor,
            metadata: {},
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!created) {
          const [existing] = await tx
            .select({
              id: retailStockOperations.id,
              operationType: retailStockOperations.operationType,
              metadata: retailStockOperations.metadata,
            })
            .from(retailStockOperations)
            .where(
              and(
                eq(retailStockOperations.companyId, companyId),
                eq(retailStockOperations.idempotencyKey, body.idempotencyKey)
              )
            )
            .limit(1);
          if (existing?.operationType !== "transfer_dispatch")
            throw new Error("This operation key belongs to another stock transaction");
          const prior = metadata(existing.metadata ?? {});
          // An idempotent replay may not change the stock move while silently
          // reporting success for the old request.
          if (
            prior.variantId !== body.variantId ||
            prior.fromLocationId !== body.fromLocationId ||
            prior.toLocationId !== body.toLocationId ||
            prior.quantity !== body.quantity ||
            (prior.notes ?? "") !== (body.notes ?? "")
          ) {
            throw new Error("Transfer idempotency key belongs to a different dispatch");
          }
          return { replayed: true, operationId: existing.id, status: prior.status };
        }
        // All stock changes use row locks. Dispatch never permits negative source
        // stock, even if the cashier is otherwise permitted to oversell.
        const source = await lockInventoryRow(tx, companyId, body.variantId, body.fromLocationId);
        if (source.quantity + 0.000001 < body.quantity) {
          throw new Error(`Insufficient stock for dispatch. Available: ${source.quantity}`);
        }
        const tracker = await trackRetailStockValueTx(tx, companyId, [
          { variantId: body.variantId, locationId: body.fromLocationId },
        ]);
        const after = source.quantity - body.quantity;
        await setInventoryQuantity(tx, companyId, body.variantId, body.fromLocationId, after);
        const inTransitValue = new MoneyDecimal(source.averageCost).times(body.quantity).toDecimalPlaces(2);
        const details: TransferMeta = {
          status: "otw",
          variantId: body.variantId,
          productName: variant.productName,
          color: variant.color,
          size: variant.size,
          barcode: variant.barcode,
          imageUrls: [
            ...(Array.isArray(variantPhotos?.imageUrls) ? variantPhotos.imageUrls : []),
            ...(Array.isArray(variantPhotos?.productImageUrls) ? variantPhotos.productImageUrls : []),
          ],
          fromLocationId: body.fromLocationId,
          toLocationId: body.toLocationId,
          quantity: body.quantity,
          sourceUnitCost: String(source.averageCost),
          inTransitValue: inTransitValue.toFixed(2),
          dispatchedAt: new Date().toISOString(),
          notes: body.notes ?? null,
        };
        await tx
          .update(retailStockOperations)
          .set({ metadata: details as Record<string, unknown> })
          .where(and(eq(retailStockOperations.id, created.id), eq(retailStockOperations.companyId, companyId)));
        await addMovement(tx, {
          companyId,
          variantId: body.variantId,
          locationId: body.fromLocationId,
          movementType: "transfer_out",
          quantityDelta: -body.quantity,
          before: source.quantity,
          after,
          eventKey: `transfer:${created.id}:dispatch`,
          referenceType: "retail_transfer",
          referenceId: created.id,
          createdBy: actor,
          metadata: { ...details, phase: "dispatch", toLocationId: body.toLocationId },
        });
        await tracker.post({
          kind: "transfer",
          sourceId: `dispatch-${created.id}`,
          description: `Retail transfer #${created.id} dispatched: stock in transit`,
          actor: { userId: actor, username: req.user?.username ?? null },
          contra: [
            {
              accountCode: IN_TRANSIT_ASSET,
              amount: inTransitValue,
              narration: `Retail transfer #${created.id}: in-transit stock asset`,
            },
          ],
        });
        return { replayed: false, operationId: created.id, status: "otw" as const };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });

  app.post("/api/pos/retail/transfers/:id/receive", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const transferId = Number(req.params.id);
      if (!Number.isSafeInteger(transferId) || transferId <= 0)
        return res.status(400).json({ message: "Invalid transfer" });
      const body = receiveSchema.parse(req.body);
      const actor = currentUserId(req);
      const allowed = await retailAllowedLocationIds(req, companyId);
      const result = await db.transaction(async (tx) => {
        // Lock transfer itself: two receivers cannot receive the same dispatch.
        await tx.execute(
          sql`SELECT id FROM retail_stock_operations WHERE id = ${transferId} AND company_id = ${companyId} FOR UPDATE`
        );
        const [op] = await tx
          .select()
          .from(retailStockOperations)
          .where(and(eq(retailStockOperations.id, transferId), eq(retailStockOperations.companyId, companyId)))
          .limit(1);
        if (!op || op.operationType !== "transfer_dispatch") throw new Error("Transfer not found");
        const details = metadata(op.metadata ?? {});
        // Only the receiving store confirms what physically arrived.
        if (allowed && !allowed.has(Number(details.toLocationId))) return { forbidden: true as const };
        if (details.status === "received") {
          if (details.receiveIdempotencyKey === body.idempotencyKey)
            return { replayed: true, operationId: transferId, status: "received" as const };
          throw new Error("Transfer has already been received");
        }
        if (
          details.status !== "otw" ||
          !details.variantId ||
          !details.toLocationId ||
          !details.fromLocationId ||
          !details.quantity ||
          details.sourceUnitCost == null ||
          details.inTransitValue == null
        )
          throw new Error("Transfer has incomplete dispatch evidence");
        // Only the receiving store must be open. Closing the source after
        // dispatch must not strand the goods (and their value) in transit.
        await ensureCompanyLocation(companyId, details.toLocationId);
        const dest = await lockInventoryRow(tx, companyId, details.variantId, details.toLocationId);
        const tracker = await trackRetailStockValueTx(tx, companyId, [
          { variantId: details.variantId, locationId: details.toLocationId },
        ]);
        const after = dest.quantity + details.quantity;
        await setInventoryQuantity(
          tx,
          companyId,
          details.variantId,
          details.toLocationId,
          after,
          nextAverageCost(dest.quantity, dest.averageCost, details.quantity, toNumber(details.sourceUnitCost))
        );
        await addMovement(tx, {
          companyId,
          variantId: details.variantId,
          locationId: details.toLocationId,
          movementType: "transfer_in",
          quantityDelta: details.quantity,
          before: dest.quantity,
          after,
          eventKey: `transfer:${transferId}:receive`,
          referenceType: "retail_transfer",
          referenceId: transferId,
          createdBy: actor,
          metadata: { ...details, phase: "receive", fromLocationId: details.fromLocationId },
        });
        await tracker.post({
          kind: "transfer",
          sourceId: `receive-${transferId}`,
          description: `Retail transfer #${transferId} received at location ${details.toLocationId}`,
          actor: { userId: actor, username: req.user?.username ?? null },
          contra: [
            {
              accountCode: IN_TRANSIT_ASSET,
              amount: new MoneyDecimal(details.inTransitValue).negated(),
              narration: `Retail transfer #${transferId}: clear in-transit stock asset`,
            },
          ],
        });
        await tx
          .update(retailStockOperations)
          .set({
            metadata: {
              ...details,
              status: "received",
              receivedAt: new Date().toISOString(),
              receivedBy: actor,
              receiveIdempotencyKey: body.idempotencyKey,
            },
          })
          .where(and(eq(retailStockOperations.id, transferId), eq(retailStockOperations.companyId, companyId)));
        return { replayed: false, operationId: transferId, status: "received" as const };
      });
      if ("forbidden" in result) {
        return res
          .status(403)
          .json({ code: "RETAIL_LOCATION_NOT_ASSIGNED", message: "You are not assigned to this Retail location" });
      }
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("already been received") ? 409 : 400).json({ message });
    }
  });
}
