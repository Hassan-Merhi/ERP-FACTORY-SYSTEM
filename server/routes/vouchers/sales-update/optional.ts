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
import { syncEmployeeBalancesFromEntries } from "../../_helpers";
import { readVoucherAuditState, writeVoucherAuditTx } from "../../helpers/voucherAuditTrail";
import type Decimal from "decimal.js";
import { vouchers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { nextCanonicalSourceRevision } from "../../../services/inventory/canonicalSourceRevision";
import { postOptionalToggleResidualTx, toggleVoucherStockTx, voucherInventoryLedgerTx } from "./optionalStockToggle";
import { syncPurchaseOrderGitForVoucherTx } from "../../../services/accounting/perpetualInventory/stockReceipts";
import { syncStockAdjustmentInventoryTx } from "../../../services/accounting/perpetualInventory/stockAdjustments";
import { syncFactoryInvoiceForChargeVoucherTx } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import { sendBaleMirrorMovementRefusal } from "../../../services/accounting/perpetualInventory/cutoverRefusal";
import {
  assertStoredVoucherLinesValidTx,
  replacementErrorStatus,
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

      const wasOptional = existingVoucher.optional;
      const willBeOptional = optional;

      // Activation (optional → active) is refused before any side effect when the
      // stored lines do not satisfy the active-voucher rules for the type (an active
      // balanced-type voucher must balance exactly) — wave 9 ledger safety.
      if (wasOptional && !willBeOptional) {
        try {
          await assertStoredVoucherLinesValidTx(db, { ...existingVoucher, optional: false });
        } catch (validationError: unknown) {
          const status = replacementErrorStatus(validationError);
          if (status) return res.status(status).json({ message: getErrorMessage(validationError) });
          throw validationError;
        }
      }

      // Wrap entire optional toggle in a transaction
      const toggleVoucher = {
        id,
        companyId: existingVoucher.companyId,
        voucherNumber: existingVoucher.voucherNumber,
        voucherDate: String(existingVoucher.voucherDate),
        voucherType: existingVoucher.voucherType,
        locationId: existingVoucher.locationId,
      };
      await db.transaction(async (tx) => {
        const auditBefore = await readVoucherAuditState(tx, id);
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

        // Update the optional field inside transaction
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
          extra: { optional: { old: wasOptional, new: willBeOptional } },
        });
      });

      // Fetch updated voucher outside transaction
      const updated = await storage.getVoucherById(id);
      res.json(updated);
    } catch (error: unknown) {
      if (sendBaleMirrorMovementRefusal(res, error)) return;
      if ((error as { name?: string }).name === "ValidationError") {
        return res.status(400).json({ message: getErrorMessage(error) });
      }
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
