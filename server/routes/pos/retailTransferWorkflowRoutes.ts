import type { Express } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { retailStockOperations } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { emptyQuery, idParams, validateRequest, validatedInput, type RequestSchemas } from "../../lib/validateRequest";
import { MoneyDecimal } from "../../lib/money";
import { trackRetailStockValueTx } from "../../services/retail/retailInventoryJournal";
import {
  addMovement,
  lockInventoryRow,
  nextAverageCost,
  setInventoryQuantity,
} from "../../services/retail/retailStockLedger";
import { retailAllowedLocationIds } from "./retailLocationAccess";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";
import {
  registerRetailTransferWorkflowRoutesPart1,
  IN_TRANSIT_ASSET,
  idempotency,
  metadata,
} from "./registerRetailTransferWorkflowRoutesPart1";

const receiveInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ idempotencyKey: idempotency }),
} satisfies RequestSchemas;
const toNumber = (value: unknown) => Number(value ?? 0);

/**
 * Deferred stock transfer: "dispatch" removes stock only at source and debits
 * RETAIL-IN-TRANSIT instead of a loss/expense. The distinct "receive" call is
 * required before the destination can sell those units. Both operations post
 * balanced location inventory/in-transit journals within their own transaction.
 *
 * Immediate inter-location transfer remains the original atomic endpoint.
 */
export function registerRetailTransferWorkflowRoutes(app: Express): void {
  registerRetailTransferWorkflowRoutesPart1(app);

  app.post(
    "/api/pos/retail/transfers/:id/receive",
    requireAuth,
    requireNonPOS,
    validateRequest(receiveInput),
    async (req, res) => {
      try {
        const companyId = await requireRetailCompany(req, res);
        if (!companyId) return;
        const { params, body } = validatedInput(req, receiveInput);
        const transferId = params.id;
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
    }
  );
}
