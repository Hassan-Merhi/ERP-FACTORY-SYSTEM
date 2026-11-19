import { HttpError, sendHttpError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { validateRequest } from "../../lib/validateRequest";
import { updatePurchaseOrderInput } from "./purchaseOrderRouteSchemas";
import { logAudit } from "../_helpers";
import { containers, purchaseOrders } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { differsByMoreThanTolerance as differs, syncIntercoParentVoucher } from "./containerHelpers";
import { moneyString, sumMoney, toMoney } from "../../lib/money";
import { sendVoucherCorrectionRefusal } from "../../services/factory/factoryVoucherCorrection";

import { syncContainerCharges } from "./containerChargeSync";
import { syncPurchaseOrderOwnFreightVoucherTx } from "./purchaseOrderOwnFreightVoucher";
import { registerPurchaseOrderDeleteRoute } from "./purchaseOrderDeleteRoute";
import { registerPoImportBackfillRoute } from "./poImportBackfillRoute";
import { syncPurchaseOrderGitTx } from "../../services/accounting/perpetualInventory/stockReceipts";
import { runWithVerifiedPoParentScope } from "../../services/security/parentCompanyPostingScope";
import { containerFreightWriteRoutesStep } from "./containerFreightWriteRoutesStep";
import { containerFreightWriteRoutesStep2 } from "./containerFreightWriteRoutesStep2";
import { resyncPurchaseOrderVoucher } from "./containerFreightWriteRoutesVoucherResync";

export function registerContainerFreightWriteRoutes(app: Express) {
  app.patch("/api/purchase-orders/:id", requireAuth, validateRequest(updatePurchaseOrderInput), async (req, res) => {
    try {
      const cfw1 = await containerFreightWriteRoutesStep({ req, res });
      if (cfw1.done) return cfw1.value;
      const {
        existingPO,
        newLocalVoucherTotal,
        oldLocalVoucherTotal,
        freightPaidByChanged,
        freightOwnAccountChanged,
        freightVoucherNeedsUpdate,
        freightParentVoucherNeedsUpdate,
        newHasParentFreight,
        newFreightParentAccountId,
        newFreight,
        newGrandTotal,
        supplierTotal,
        newHasOwnFreight,
        newFreightOwnAccountId,
        id,
        newItemsTotal,
        newSurcharge,
        newFumigation,
        newDocumentCharges,
        newDiscount,
        newOtherCharges,
        chargesWereEdited,
        poChargeRows,
        newFreightPaidBy,
        oldFreightPaidBy,
      } = cfw1;

      // Wave 7: the PO row, its voucher and lines, the freight voucher, the
      // container totals and charges, goods in transit, the inter-company
      // counterpart and the audit row commit together or not at all (they used
      // to be separate autocommit writes, so a failure part-way left the PO and
      // its ledger disagreeing).
      const updatedPO = await runWithVerifiedPoParentScope(existingPO.companyId, (linkedParentCompanyId) =>
        db.transaction(async (tx) => {
          const cfw2 = await containerFreightWriteRoutesStep2({ cfw1, tx, req, linkedParentCompanyId });
          const { voucherTotalMismatch, _pfParentId, _isSameCompanyOrNoInterco, _freightNarration, updated } = cfw2;

          // Update voucher entries when local voucher total, freight payer, or own-account changes,
          // OR when the actual DB voucher total doesn't match the expected total.
          if (
            voucherTotalMismatch ||
            differs(newLocalVoucherTotal, oldLocalVoucherTotal) ||
            freightPaidByChanged ||
            freightOwnAccountChanged ||
            freightVoucherNeedsUpdate ||
            freightParentVoucherNeedsUpdate
          ) {
            {
              await resyncPurchaseOrderVoucher({
                existingPO,
                voucherTotalMismatch,
                newLocalVoucherTotal,
                oldLocalVoucherTotal,
                freightPaidByChanged,
                freightOwnAccountChanged,
                freightParentVoucherNeedsUpdate,
                tx,
                req,
                newHasParentFreight,
                newFreightParentAccountId,
                _pfParentId,
                _isSameCompanyOrNoInterco,
                newFreight,
                newGrandTotal,
                supplierTotal,
                _freightNarration,
                newHasOwnFreight,
                newFreightOwnAccountId,
              });

              // (interco sync moved to unconditional block below the transaction)

              // Update container totals if applicable
              const [container] = await tx
                .select()
                .from(containers)
                .where(and(eq(containers.id, existingPO.containerId), eq(containers.companyId, existingPO.companyId)))
                .limit(1);
              if (container) {
                // Get all POs for this container and recalculate totals
                const containerPOs = await tx
                  .select()
                  .from(purchaseOrders)
                  .where(
                    and(
                      eq(purchaseOrders.companyId, existingPO.companyId),
                      eq(purchaseOrders.containerId, existingPO.containerId)
                    )
                  );
                // Use the new values for this PO, the stored ones for the others.
                const poAmounts = containerPOs.map((po) =>
                  po.id === id
                    ? {
                        itemsTotal: newItemsTotal,
                        freight: newFreight,
                        surcharge: newSurcharge,
                        fumigation: newFumigation,
                        documentCharges: newDocumentCharges,
                        discount: newDiscount,
                        otherCharges: newOtherCharges,
                      }
                    : po
                );
                const totalItemsCost = sumMoney(poAmounts.map((po) => po.itemsTotal));
                const totalCharges = sumMoney(
                  poAmounts.flatMap((po) => [
                    po.freight,
                    po.surcharge,
                    po.fumigation,
                    po.documentCharges,
                    toMoney(po.discount).negated(),
                    po.otherCharges,
                  ])
                );

                // Update container totals
                await tx
                  .update(containers)
                  .set({
                    itemsTotal: moneyString(totalItemsCost),
                    chargesTotal: moneyString(totalCharges),
                    grandTotal: moneyString(totalItemsCost.plus(totalCharges)),
                  })
                  .where(eq(containers.id, existingPO.containerId));
              }

              // Sync container_charges table when PO charges are edited
              if (chargesWereEdited && existingPO.containerId) {
                await syncContainerCharges(tx, existingPO.containerId, poChargeRows);
              }

              // ── Freight own-account voucher ───────────────────────────────────
              // Create/update/retire the standalone own-account freight Payment
              // voucher (see ./purchaseOrderOwnFreightVoucher.ts).
              await syncPurchaseOrderOwnFreightVoucherTx(tx, req, {
                existingPO: existingPO,
                container,
                newFreight: newFreight,
                newFreightOwnAccountId: newFreightOwnAccountId,
                newFreightPaidBy: newFreightPaidBy,
                oldFreightPaidBy: oldFreightPaidBy,
                freightVoucherNeedsUpdate: freightVoucherNeedsUpdate,
              });
            }
          } else if (chargesWereEdited && existingPO.containerId) {
            // If charges were edited but grand total didn't change (or no voucher), still sync container_charges
            await syncContainerCharges(tx, existingPO.containerId, poChargeRows);
          }

          // Perpetual inventory (wave 8.2): goods in transit follows the edited PO voucher.
          await syncPurchaseOrderGitTx(tx, existingPO.companyId, existingPO.id);

          // ── Inter-company sync — runs unconditionally after every charges-only update.
          // (Branch 1/items path runs its own sync inside the transaction above.)
          // Pass grossTotal (not supplierTotal) so the DR subsidiary entry is correct,
          // and include freight opts so the parent CR is split between supplier + freight account.
          {
            const _b2ParentId = linkedParentCompanyId;
            if (_b2ParentId && existingPO.companyId !== _b2ParentId) {
              const _b2NewPoNum =
                req.body.poNumber && req.body.poNumber !== existingPO.poNumber ? (req.body.poNumber as string) : null;
              const _b2PoNums = _b2NewPoNum ? [existingPO.poNumber, _b2NewPoNum] : existingPO.poNumber;
              const _b2ContainerRow = existingPO.containerId
                ? (
                    await tx
                      .select({ containerNumber: containers.containerNumber })
                      .from(containers)
                      .where(eq(containers.id, existingPO.containerId))
                      .limit(1)
                  )[0]
                : undefined;
              const _b2Sync = await syncIntercoParentVoucher(
                tx,
                _b2PoNums,
                newGrandTotal,
                _b2ContainerRow?.containerNumber,
                newHasParentFreight && newFreightParentAccountId
                  ? {
                      freightAmount: newFreight,
                      freightParentAccountId: newFreightParentAccountId,
                      subsidiaryCompanyId: existingPO.companyId,
                    }
                  : undefined,
                _b2ParentId,
                existingPO.companyId
              );
              if (!_b2Sync.found) {
                throw new HttpError(
                  409,
                  "Parent intercompany journal missing for this container; purchase-order edit was not saved."
                );
              }
            }
          }

          // INTERCO-FREIGHT sync removed — freight is now inside the purchase voucher itself.

          {
            const _poChanges: Record<string, { old: unknown; new: unknown }> = {};
            for (const _f of [
              "poNumber",
              "currency",
              "status",
              "freight",
              "surcharge",
              "fumigation",
              "documentCharges",
              "discount",
              "otherCharges",
              "itemsTotal",
            ] as const) {
              if (String(existingPO[_f] ?? "") !== String(updated[_f] ?? "")) {
                _poChanges[_f] = { old: existingPO[_f], new: updated[_f] };
              }
            }
            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || "unknown",
                companyId: req.session.currentCompanyId!,
                action: "update",
                tableName: "purchase_orders",
                recordId: id,
                recordIdentifier: existingPO.poNumber || `PO #${id}`,
                changes: _poChanges,
              },
              tx
            );
          }
          return updated;
        })
      );
      res.json(updatedPO);
    } catch (error: unknown) {
      // Identify the exact retired voucher linked to a failed PO edit without
      // exposing accounting details to the API client.
      if (error instanceof Error) {
        const correction = error as Error & { code?: string; details?: { voucherId?: number } };
        logger.warn("[PO-PATCH refusal]", {
          poId: req.params.id,
          companyId: req.session.currentCompanyId,
          code: correction.code ?? "UNKNOWN",
          voucherId: correction.details?.voucherId ?? null,
          message: error.message,
        });
      }
      if (sendVoucherCorrectionRefusal(res, error)) return;
      sendHttpError(res, error);
    }
  });

  registerPurchaseOrderDeleteRoute(app);

  // Delete a container (Admin only)

  registerPoImportBackfillRoute(app);

  // Backfill voucher entries for existing sales
}
