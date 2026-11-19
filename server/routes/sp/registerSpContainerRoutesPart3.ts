// Extracted from ./registerSpContainerRoutesPart2.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { and, eq, sql } from "drizzle-orm";
import { spContainers, voucherEntries, vouchers } from "@shared/schema";
import { getSpAccount, parseNum, requireSpCompany } from "./spHelpers";
import { parseMoneyInput, toMoney } from "../../lib/money";
import { postFactoryPartyLineVoucherTx, usdLineAmounts } from "../../services/factory/factoryVoucherPosting";
import {
  editPostedFactoryVoucherTx,
  sendVoucherCorrectionRefusal,
} from "../../services/factory/factoryVoucherCorrection";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { validateRequest, validatedInput } from "../../lib/validateRequest";
import { updateSpContainerInput } from "./spContainerRequestSchemas";

export function registerSpContainerRoutesPart3(app: Express) {
  // PATCH /api/sp/containers/:id — edit header fields + regenerate OTW voucher
  app.patch(
    "/api/sp/containers/:id",
    requireAuth,
    validateRequest(updateSpContainerInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = await requireSpCompany(req, res);
        if (!companyId) return;

        const containerId = validatedInput(req, updateSpContainerInput).params.id;

        const containerEditConflictMessage = "Cannot edit an offloaded container";

        const [existing] = await db
          .select()
          .from(spContainers)
          .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)));
        if (!existing) return res.status(404).json({ message: "Container not found" });
        if (existing.status === "offloaded") {
          return res.status(400).json({ message: containerEditConflictMessage });
        }

        const {
          supplierId,
          supplierName,
          containerNumber,
          invoiceNumber,
          invoiceDate,
          invoiceTotalUsd,
          discountPct,
          freightEstimateUsd,
          surchargeUsd,
          fumigationUsd,
          documentChargesUsd,
          notes,
        } = req.body;

        const otwAcct = await getSpAccount(companyId, "sp_goods_otw");
        const otwClrAcct = await getSpAccount(companyId, "sp_otw_clearing");
        if (!otwAcct || !otwClrAcct) {
          return res.status(400).json({ message: "Chart of accounts not set up" });
        }

        const updated = await db.transaction(async (tx) => {
          // Lock the lifecycle row before deriving defaults or updating the OTW
          // voucher. This serializes container edits with offload/reversal work and
          // prevents a stale pre-check from editing a container after it was offloaded.
          const [lockedExisting] = await tx
            .select()
            .from(spContainers)
            .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)))
            .limit(1)
            .for("update");

          if (!lockedExisting || lockedExisting.status === "offloaded") {
            return null;
          }

          const totalUsd = (
            parseMoneyInput(invoiceTotalUsd ?? lockedExisting.invoiceTotalUsd) ?? toMoney(0)
          ).toDecimalPlaces(2);
          const supplierIdNum = supplierId ? parseInt(String(supplierId)) : (lockedExisting.supplierId ?? null);
          const newSupplierName = supplierName ?? lockedExisting.supplierName;
          const newInvoiceNumber = invoiceNumber ?? lockedExisting.invoiceNumber;
          const newInvoiceDate = invoiceDate ?? lockedExisting.invoiceDate;

          // Update container fields
          const [updatedContainer] = await tx
            .update(spContainers)
            .set({
              supplierId: supplierIdNum,
              supplierName: newSupplierName,
              containerNumber: containerNumber !== undefined ? containerNumber || null : lockedExisting.containerNumber,
              invoiceNumber: newInvoiceNumber,
              invoiceDate: newInvoiceDate,
              invoiceTotalUsd: totalUsd.toFixed(2),
              discountPct: String(parseNum(discountPct ?? lockedExisting.discountPct)),
              freightEstimateUsd: String(parseNum(freightEstimateUsd ?? lockedExisting.freightEstimateUsd)),
              surchargeUsd: String(parseNum(surchargeUsd ?? lockedExisting.surchargeUsd)),
              fumigationUsd: String(parseNum(fumigationUsd ?? lockedExisting.fumigationUsd)),
              documentChargesUsd: String(parseNum(documentChargesUsd ?? lockedExisting.documentChargesUsd)),
              notes: notes !== undefined ? notes || null : lockedExisting.notes,
            })
            .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)))
            .returning();

          // Regenerate OTW voucher if amount or supplier changed
          if (lockedExisting.goodsOtwVoucherId && totalUsd.greaterThan(0)) {
            const otwVoucherId = lockedExisting.goodsOtwVoucherId;
            // Phase 22 (C), G4/PE9: an audited open-period edit of the posted OTW
            // voucher (refused with 409 in a closed period: reverse and re-post).
            await editPostedFactoryVoucherTx(
              tx,
              {
                companyId,
                voucherIds: [otwVoucherId],
                reason: "sp-container-otw-edit",
                actor: { userId: req.session.userId, username: req.session.username },
                newVoucherDate: newInvoiceDate,
              },
              async () => {
                await tx
                  .update(vouchers)
                  .set({
                    voucherDate: newInvoiceDate,
                    description: `Goods OTW: ${newSupplierName} — Invoice ${newInvoiceNumber}`,
                    totalAmount: totalUsd.toFixed(2),
                  })
                  .where(eq(vouchers.id, otwVoucherId));
                // Wave 16 (A): the edit carries the container's supplier on the header
                // itself; the container trigger no longer rewrites posted vouchers.
                await tx.execute(
                  sql`UPDATE vouchers SET supplier_id = ${supplierIdNum}
                     WHERE id = ${otwVoucherId} AND company_id = ${companyId}
                       AND supplier_id IS DISTINCT FROM ${supplierIdNum}`
                );
                // Delete old entries and recreate with updated amounts
                await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, otwVoucherId));
                await tx.insert(voucherEntries).values([
                  {
                    voucherId: otwVoucherId,
                    ledgerAccountId: otwAcct.id,
                    ...usdLineAmounts(totalUsd, 0),
                    narration: `Goods OTW — ${newSupplierName} inv ${newInvoiceNumber}`,
                  },
                  {
                    voucherId: otwVoucherId,
                    ledgerAccountId: otwClrAcct.id,
                    supplierId: supplierIdNum,
                    ...usdLineAmounts(0, totalUsd),
                    narration: `OTW Clearing — ${newSupplierName} inv ${newInvoiceNumber}`,
                  },
                ]);
              }
            );
          } else if (!lockedExisting.goodsOtwVoucherId && totalUsd.greaterThan(0)) {
            // Create new voucher if none existed
            const { voucherId } = await postFactoryPartyLineVoucherTx(tx, {
              companyId,
              voucherNumber: (generation) => `SP-OTW-${containerId}-${generation}`,
              voucherDate: newInvoiceDate,
              description: `Goods OTW: ${newSupplierName} — Invoice ${newInvoiceNumber}`,
              sourceModule: "SP",
              source: { sourceType: "sp-container-otw", sourceId: `${companyId}:${containerId}`, phase: "voucher" },
              lines: [
                {
                  ledgerAccountId: otwAcct.id,
                  debit: totalUsd,
                  narration: `Goods OTW — ${newSupplierName} inv ${newInvoiceNumber}`,
                },
                {
                  ledgerAccountId: otwClrAcct.id,
                  supplierId: supplierIdNum,
                  credit: totalUsd,
                  narration: `OTW Clearing — ${newSupplierName} inv ${newInvoiceNumber}`,
                },
              ],
            });
            await tx.update(spContainers).set({ goodsOtwVoucherId: voucherId }).where(eq(spContainers.id, containerId));
          }

          return updatedContainer;
        });

        if (!updated) {
          return res.status(409).json({
            code: "SP_CONTAINER_STATE_CONFLICT",
            message: containerEditConflictMessage,
          });
        }

        res.json(updated);
      } catch (error: unknown) {
        if (sendVoucherCorrectionRefusal(res, error)) return;
        if (error instanceof PostingValidationError)
          return res.status(400).json({ code: error.code, message: error.message });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
