/**
 * voucherSalesUpdateRoutes: VoucherOptionalUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import {
  assertNotIntercompanyTransferLeg,
  sendIntercompanyTransferLegRefusal,
} from "../../../services/accounting/intercompanyTransferLegGuard";
import { syncEmployeeBalancesFromEntries } from "../../_helpers";
import { writeVoucherAuditTx } from "../../helpers/voucherAuditTrail";
import type Decimal from "decimal.js";
import { vouchers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { nextCanonicalSourceRevision } from "../../../services/inventory/canonicalSourceRevision";
import { assertPosOptionalSettlementSafeTx } from "../../../services/pos/posOptionalSafety";
import { postOptionalToggleResidualTx, toggleVoucherStockTx, voucherInventoryLedgerTx } from "./optionalStockToggle";
import { syncPurchaseOrderGitForVoucherTx } from "../../../services/accounting/perpetualInventory/stockReceipts";
import { syncStockAdjustmentInventoryTx } from "../../../services/accounting/perpetualInventory/stockAdjustments";
import { syncFactoryInvoiceForChargeVoucherTx } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import { sendBaleMirrorMovementRefusal } from "../../../services/accounting/perpetualInventory/cutoverRefusal";
import { assertVoucherEditableTx, sendVoucherCorrectionRefusal } from "../../../services/accounting/voucherCorrection";
import {
  assertStoredVoucherLinesValidTx,
} from "../../../services/accounting/voucherEntryReplacement";

export function registerVoucherOptionalUpdateRoutes(app: Express) {
  // Toggle optional status for a voucher
  app.patch("/api/vouchers/:id/optional", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      const { optional } = req.body;
      if (typeof optional !== "boolean") {
        return res.status(400).json({ message: "Optional must be a boolean value" });
      }

      // Get the existing voucher to check company and permissions
      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      // Verify voucher belongs to current company
      if (existingVoucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Voucher belongs to a different company",
        });
      }

      const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }

      // Only Admin and Owner can toggle optional status
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({
          message: "Only Admin and Owner can toggle optional status",
        });
      }

      // Phase 19 C (MC-2): suspending or activating one leg of an intercompany
      // transfer would post or unpost one company's side only (409).
      if (existingVoucher.optional !== optional) {
        try {
          await assertNotIntercompanyTransferLeg(id);
        } catch (legError: unknown) {
          if (sendIntercompanyTransferLegRefusal(res, legError)) return;
          throw legError;
        }
      }

      const willBeOptional = optional;

      // The lock and fresh optional flag MUST be read in the transaction.
      // A second simultaneous click must never restore or deduct the same
      // inventory a second time based on an earlier, stale HTTP read.
      await db.transaction(async (tx) => {
        const { voucher: lockedVoucher, before: auditBefore } =
          await assertVoucherEditableTx(tx, id, { companyId: existingVoucher.companyId });
        const wasOptional = lockedVoucher.optional;
        if (wasOptional === willBeOptional) return;
        await assertPosOptionalSettlementSafeTx(tx, lockedVoucher);

        // Re-check balanced lines while the voucher is locked, not against the
        // pre-transaction snapshot. A failed activation changes no inventory.
        if (wasOptional && !willBeOptional) {
          await assertStoredVoucherLinesValidTx(tx, { ...lockedVoucher, optional: false });
        }

        const toggleVoucher = {
          id,
          companyId: lockedVoucher.companyId,
          voucherNumber: lockedVoucher.voucherNumber,
          voucherDate: String(lockedVoucher.voucherDate),
          voucherType: lockedVoucher.voucherType,
          locationId: lockedVoucher.locationId,
        };
        const ledgerBefore = await voucherInventoryLedgerTx(tx, toggleVoucher);
        let toggleDeltas: Decimal[] = [];
        let toggleRevision: number | null = null;

        // Handle inventory changes when toggling optional status
        // If changing from false→true: reverse inventory changes
        // If changing from true→false: apply inventory changes
        if (wasOptional !== willBeOptional) {
          const evidenceRevision = await nextCanonicalSourceRevision(
            tx,
            existingVoucher.companyId,
            "voucher-optional-toggle",
            String(id)
          );
          const occurredAt = new Date().toISOString();
          const evidenceActor = {
            userId: req.session.userId,
            username: req.session.username,
            reason: `${willBeOptional ? "Suspend" : "Activate"} voucher ${existingVoucher.voucherNumber}`,
          };

          // Wave 11: value-exact (see optionalStockToggle).
          toggleDeltas = await toggleVoucherStockTx(tx, {
            voucher: toggleVoucher,
            willBeOptional,
            evidenceRevision,
            occurredAt,
            evidenceActor,
          });
          toggleRevision = evidenceRevision;
        }

        // Update the optional field inside the same stock/accounting transaction.
        await tx.update(vouchers).set({ optional }).where(eq(vouchers.id, id));
        // Perpetual inventory (wave 8.2): an optional PO voucher is not in transit.
        await syncPurchaseOrderGitForVoucherTx(tx, existingVoucher.companyId, id);
        // Perpetual inventory (wave 8.3): an optional stock adjustment carries no inventory line.
        await syncStockAdjustmentInventoryTx(tx, existingVoucher.companyId, id);
        // Perpetual inventory (wave 8.4): an order whose charge this voucher carries re-syncs its invoice journal.
        await syncFactoryInvoiceForChargeVoucherTx(tx, existingVoucher.companyId, id);
        if (toggleRevision !== null) {
          await postOptionalToggleResidualTx(tx, {
            voucher: toggleVoucher,
            evidenceRevision: toggleRevision,
            deltas: toggleDeltas,
            ledgerBefore,
            actor: req.session.userId
              ? { userId: req.session.userId, username: req.session.username || "unknown" }
              : null,
          });
        }

        // Wave 12: employee balances move in this transaction, and the toggle is
        // audited with the full voucher snapshot before it commits.
        if (wasOptional !== willBeOptional) {
          await syncEmployeeBalancesFromEntries(auditBefore.entries, existingVoucher.companyId, willBeOptional, tx);
        }
        const auditAfter = await readVoucherAuditState(tx, id);
        await writeVoucherAuditTx(tx, {
          actor: {
            userId: req.session.userId,
            username: req.session.username,
            companyId: existingVoucher.companyId,
          },
          action: "update",
          voucherId: id,
          before: auditBefore,
          after: auditAfter,
          extra: {
            optional: { old: wasOptional, new: willBeOptional },
            ...(wasOptional !== willBeOptional ? { correctionPolicy: { new: "open-period-edit" } } : {}),
          },
        });
      });

      // Fetch updated voucher outside transaction
      const updated = await storage.getVoucherById(id);
      res.json(updated);
    } catch (error: unknown) {
      if (sendBaleMirrorMovementRefusal(res, error)) return;
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if ((error as { name?: string }).name === "ValidationError") {
        return res.status(400).json({ message: getErrorMessage(error) });
      }
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
