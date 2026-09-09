/**
 * factoryDocsUsersRoutes: FactoryDaybookEdit endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { asRecord, isNonEmptyString, toPositiveInteger } from "@shared/typeGuards";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry, recalculateContainerCosts } from "../_helpers";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../../services/factory/currencyConversion";
import {
  factoryContainers,
  factoryRawStock,
  factoryContainerCommissions,
  voucherEntries,
  factoryDaybookEntries,
  factoryDaybookEntryEdits,
  factoryDutyAuditLog,
  factoryOffloadAdditionalCharges,
  factoryPayrolls,
  employees,
  vouchers,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
} from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";

export function registerFactoryDaybookEditRoutes(app: Express) {
  // ─────── DAYBOOK ENTRY EDIT ───────

  app.put("/api/factory/daybook/:entryId", requireAuth, async (req: Request, res: Response) => {
    try {
      const rawEntryId = Number(req.params.entryId);
      if (isNaN(rawEntryId)) return res.status(400).json({ message: "Invalid entry ID" });
      const session = req.session;
      const companyId = session.factoryCompanyId || session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const userId = session.userId ?? null;
      const { reason, description, amountCurrency, amountUsd, currencyCode, fxRateToUsd, txDate } = req.body;

      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return res.status(400).json({ message: "Edit reason is required" });
      }

      const currentRole = (session.currentRole || session.role || "").toLowerCase();
      const canEdit = ["admin", "owner", "developer"].includes(currentRole) || (session.daybookEditDays ?? 0) > 0;
      if (!canEdit) return res.status(403).json({ message: "You do not have permission to edit daybook entries" });

      let existing:
        | {
            id: number;
            companyId: number;
            createdAt: Date;
            currencyCode: string;
            fxRateToUsd: string;
            description: string;
            effectiveDate: string | null;
            createdBy: string | null;
            referenceId: number | null;
            amountUsd: string;
            txDate: string;
            txType: string;
            referenceTable: string | null;
            metaJson: string | null;
            amountCurrency: string;
          }
        | {
            id: number;
            companyId: number;
            txDate: string;
            txType: string;
            referenceId: number | null;
            referenceTable: string | null;
            description: string;
            metaJson: string | null;
            currencyCode: string;
            amountCurrency: string;
            fxRateToUsd: string;
            amountUsd: string;
            effectiveDate: string | null;
            createdAt: Date;
            createdBy: string | null;
          };
      let realEntryId: number;

      if (rawEntryId < 0) {
        // ── Synthetic row: backed by a voucher not yet in factory_daybook_entries ──
        // Negative ID means Math.abs(rawEntryId) is the voucher ID.
        const realVoucherId = Math.abs(rawEntryId);
        const [sourceVoucher] = await db.select().from(vouchers).where(eq(vouchers.id, realVoucherId));
        if (!sourceVoucher) return res.status(404).json({ message: "Source voucher not found" });

        const voucherTxTypeMap: Record<string, string> = { Payment: "PAYMENT", Receipt: "RECEIPT", Journal: "JOURNAL" };
        const txTypeVal = voucherTxTypeMap[sourceVoucher.voucherType] || "JOURNAL";
        const currency = sourceVoucher.currency || "USD";
        const fxRate = parseFloat(sourceVoucher.exchangeRate || "1") || 1;
        const amtCurrency = parseFloat(sourceVoucher.totalAmount || "0");
        const amtUsd = currency === "USD" ? amtCurrency : amtCurrency * fxRate;

        // Insert a real daybook entry from this voucher so it can be edited going forward
        const [inserted] = await db
          .insert(factoryDaybookEntries)
          .values({
            companyId,
            txDate: sourceVoucher.voucherDate,
            txType: txTypeVal,
            referenceId: realVoucherId,
            referenceTable: "vouchers",
            description:
              description !== undefined
                ? description
                : sourceVoucher.description || `${sourceVoucher.voucherType} voucher #${sourceVoucher.voucherNumber}`,
            currencyCode: currency,
            amountCurrency: String(amtCurrency),
            fxRateToUsd: String(fxRate),
            amountUsd: String(amtUsd),
            createdBy: userId,
          })
          .returning();
        existing = inserted;
        realEntryId = inserted.id;
      } else {
        // ── Real daybook entry ────────────────────────────────────────────────
        const [found] = await db
          .select()
          .from(factoryDaybookEntries)
          .where(and(eq(factoryDaybookEntries.id, rawEntryId), eq(factoryDaybookEntries.companyId, companyId)));
        if (!found) return res.status(404).json({ message: "Daybook entry not found" });
        existing = found;
        realEntryId = rawEntryId;
      }

      const isPrivilegedRole = ["admin", "owner", "developer"].includes(currentRole);
      if (!isPrivilegedRole && session.daybookEditDays) {
        const entryDate = new Date(existing.txDate);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - session.daybookEditDays);
        if (entryDate < cutoff) {
          return res
            .status(403)
            .json({ message: `Entry is older than ${session.daybookEditDays} days and cannot be edited` });
        }
      }

      const beforeJson = JSON.stringify(existing);

      const updates: PgUpdateSetSource<typeof factoryDaybookEntries> = {};
      if (description !== undefined) updates.description = description;
      if (amountCurrency !== undefined) updates.amountCurrency = String(amountCurrency);
      if (amountUsd !== undefined) updates.amountUsd = String(amountUsd);
      if (currencyCode !== undefined) updates.currencyCode = currencyCode;
      if (fxRateToUsd !== undefined) updates.fxRateToUsd = String(fxRateToUsd);
      if (txDate !== undefined) updates.txDate = txDate;

      const [updated] = await db
        .update(factoryDaybookEntries)
        .set(updates)
        .where(eq(factoryDaybookEntries.id, realEntryId))
        .returning();
      const afterJson = JSON.stringify(updated);

      await db.insert(factoryDaybookEntryEdits).values({
        daybookEntryId: realEntryId,
        editedBy: userId,
        beforeJson,
        afterJson,
        reason: reason.trim(),
      });

      // ── Sync description and date back to the source voucher so Accounts statements stay in sync ──
      if (updated.referenceTable === "vouchers" && updated.referenceId) {
        const voucherUpdates: PgUpdateSetSource<typeof vouchers> = {};
        if (description !== undefined) voucherUpdates.description = description;
        if (txDate !== undefined) voucherUpdates.voucherDate = txDate;
        if (Object.keys(voucherUpdates).length > 0) {
          await db
            .update(vouchers)
            .set(voucherUpdates)
            .where(and(eq(vouchers.id, updated.referenceId), eq(vouchers.companyId, companyId)));
        }
      }

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error editing daybook entry:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/daybook/:entryId/edits", requireAuth, async (req: Request, res: Response) => {
    try {
      const entryId = Number(req.params.entryId);
      const edits = await db
        .select()
        .from(factoryDaybookEntryEdits)
        .where(eq(factoryDaybookEntryEdits.daybookEntryId, entryId))
        .orderBy(desc(factoryDaybookEntryEdits.editedAt));
      res.json(edits);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH /api/factory/daybook/:entryId/cost-edit — Edit a container cost entry and cascade changes
  // Supports: OFFLOAD_RAW_STOCK, FREIGHT, COMMISSION, DUTY, OTHER_CHARGE
  // Restricted to admin/owner/developer. Triggers full container cost recalculation.
  app.patch("/api/factory/daybook/:entryId/cost-edit", requireAuth, async (req: Request, res: Response) => {
    try {
      const session = req.session;
      const companyId = session.factoryCompanyId || session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const userId = session.userId ?? null;

      const currentRole = (session.currentRole || session.role || "").toLowerCase();
      if (!["admin", "owner", "developer"].includes(currentRole)) {
        return res.status(403).json({ message: "Only Admin/Owner/Developer can edit container cost entries" });
      }

      const entryId = Number(req.params.entryId);
      if (isNaN(entryId) || entryId <= 0) return res.status(400).json({ message: "Invalid entry ID" });

      const { newAmount, reason, newCurrencyCode, newFxRate } = req.body;
      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return res.status(400).json({ message: "Edit reason is required" });
      }
      const parsedAmount = parseFloat(newAmount);
      if (isNaN(parsedAmount) || parsedAmount < 0) {
        return res.status(400).json({ message: "newAmount must be a non-negative number" });
      }

      const COST_TX_TYPES = ["OFFLOAD_RAW_STOCK", "FREIGHT", "COMMISSION", "DUTY", "OTHER_CHARGE"];

      const [entry] = await db
        .select()
        .from(factoryDaybookEntries)
        .where(and(eq(factoryDaybookEntries.id, entryId), eq(factoryDaybookEntries.companyId, companyId)));
      if (!entry) return res.status(404).json({ message: "Daybook entry not found" });
      if (!COST_TX_TYPES.includes(entry.txType)) {
        return res
          .status(400)
          .json({ message: `txType '${entry.txType}' is not a cost entry — use the standard edit endpoint` });
      }

      // Parse metaJson to determine exact source
      // metaJson is free-form persisted JSON, so it stays `unknown` until each
      // field below is coerced; asRecord keeps a non-object payload from
      // becoming property reads on a string or array.
      let meta: Record<string, unknown> = {};
      try {
        meta = asRecord(JSON.parse(entry.metaJson || "{}")) ?? {};
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }

      // Resolve containerId from metaJson or txType + referenceId fallback
      let containerId: number | null = toPositiveInteger(meta.containerId) ?? null;
      if (!containerId) {
        if (entry.txType === "FREIGHT" || entry.txType === "DUTY" || entry.txType === "OTHER_CHARGE") {
          containerId = entry.referenceId;
        } else if (entry.txType === "OFFLOAD_RAW_STOCK") {
          // referenceId = rawStock.id; look up containerId from rawStock
          const [rs] = await db
            .select({ containerId: factoryRawStock.containerId })
            .from(factoryRawStock)
            .where(eq(factoryRawStock.id, entry.referenceId!));
          containerId = rs?.containerId ?? null;
        } else if (entry.txType === "COMMISSION") {
          // referenceId = commissionRecord.id; look up containerId from commission
          const [comm] = await db
            .select({ containerId: factoryContainerCommissions.containerId })
            .from(factoryContainerCommissions)
            .where(eq(factoryContainerCommissions.id, entry.referenceId!));
          containerId = comm?.containerId ?? null;
        }
      }
      if (!containerId) return res.status(400).json({ message: "Cannot resolve container from this daybook entry" });

      const [container] = await db
        .select()
        .from(factoryContainers)
        .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
      if (!container) return res.status(404).json({ message: "Container not found" });

      const beforeJson = JSON.stringify(entry);
      const sourceType: string = isNonEmptyString(meta.sourceType) ? meta.sourceType : entry.txType;

      await db.transaction(async (tx) => {
        // ── 1. Update the specific source record ────────────────────────────────
        if (sourceType === "BASE_MATERIAL" || entry.txType === "OFFLOAD_RAW_STOCK") {
          // Editing base material cost: derive new ratePerKg from amount / actualKg
          const actualKg = parseFloat(container.actualReceivedKg || "0");
          if (actualKg <= 0) throw new Error("Container has no received weight");
          const newRate = parsedAmount / actualKg;
          const ccy = newCurrencyCode || container.currencyCode || "USD";
          await tx
            .update(factoryContainers)
            .set({ ratePerKg: String(newRate.toFixed(6)), currencyCode: ccy, updatedAt: new Date() })
            .where(eq(factoryContainers.id, containerId!));
        } else if (sourceType === "FREIGHT" || entry.txType === "FREIGHT") {
          const ccy =
            newCurrencyCode ||
            (container as { freightCurrencyCode: unknown }).freightCurrencyCode ||
            container.currencyCode ||
            "USD";
          let fx: string;
          if (newFxRate) {
            fx = String(newFxRate); // fresh explicit request input — trust it even if it equals 1
          } else {
            const fallbackRaw = container.fxRateToUsdOffload || container.fxRateToUsd;
            const { fxRate: resolvedFx, looksSet } = resolveStoredFxRate(ccy, fallbackRaw, container.fxRateConfirmed);
            if (!looksSet) throw new UnresolvedExchangeRateError(ccy);
            fx = String(resolvedFx);
          }
          await tx
            .update(factoryContainers)
            .set({ freight: String(parsedAmount), updatedAt: new Date() })
            .where(eq(factoryContainers.id, containerId!));
          // Also update the daybook entry currency if it changed
          if (newCurrencyCode) {
            await tx
              .update(factoryDaybookEntries)
              .set({ currencyCode: ccy, fxRateToUsd: fx })
              .where(eq(factoryDaybookEntries.id, entryId));
          }
        } else if (sourceType === "COMMISSION" || entry.txType === "COMMISSION") {
          const commId = toPositiveInteger(meta.commissionId) ?? entry.referenceId;
          if (commId) {
            await tx
              .update(factoryContainerCommissions)
              .set({ commissionTotal: String(parsedAmount) })
              .where(eq(factoryContainerCommissions.id, commId));
          }
          // Also sync the commissionAmount summary on the container
          await tx
            .update(factoryContainers)
            .set({ commissionAmount: String(parsedAmount), updatedAt: new Date() })
            .where(eq(factoryContainers.id, containerId!));
        } else if (sourceType === "DUTY" || entry.txType === "DUTY") {
          if (container.dutyStatus !== "CONFIRMED") {
            throw new Error(
              "Duty can only be edited when its status is CONFIRMED. Use the confirm-duty flow for PENDING duty."
            );
          }
          const oldDuty = container.dutyAmount;
          await tx
            .update(factoryContainers)
            .set({ dutyAmount: String(parsedAmount), updatedAt: new Date() })
            .where(eq(factoryContainers.id, containerId!));
          // Write duty audit log
          await tx.insert(factoryDutyAuditLog).values({
            companyId,
            containerId,
            oldDutyAmount: oldDuty || "0",
            newDutyAmount: String(parsedAmount),
            oldDutyStatus: "CONFIRMED",
            newDutyStatus: "CONFIRMED",
            notes: `Edited via daybook cost-edit. Reason: ${reason.trim()}`,
            updatedByUserId: String(userId || "system"),
          });
        } else if (sourceType === "CONTAINER_OC") {
          await tx
            .update(factoryContainers)
            .set({ otherCharges: String(parsedAmount), updatedAt: new Date() })
            .where(eq(factoryContainers.id, containerId!));
        } else if (sourceType === "OFFLOAD_ADDITIONAL" || sourceType === "POST_OFFLOAD_ADDITIONAL") {
          const chargeId = toPositiveInteger(meta.chargeId) ?? null;
          if (!chargeId) throw new Error("Missing chargeId in metaJson — cannot update individual additional charge");
          await tx
            .update(factoryOffloadAdditionalCharges)
            .set({ amount: String(parsedAmount) })
            .where(
              and(
                eq(factoryOffloadAdditionalCharges.id, chargeId),
                eq(factoryOffloadAdditionalCharges.companyId, companyId)
              )
            );
        } else {
          // Legacy fallback for entries with no metaJson — infer from txType
          if (entry.txType === "OTHER_CHARGE") {
            await tx
              .update(factoryContainers)
              .set({ otherCharges: String(parsedAmount), updatedAt: new Date() })
              .where(eq(factoryContainers.id, containerId!));
          }
        }

        // ── 2. Cascade recalculation ─────────────────────────────────────────────
        const { totalCost, inclusiveCostPerKg } = await recalculateContainerCosts(tx, companyId, containerId!);

        // ── 3. Update THIS daybook entry amount ──────────────────────────────────
        const entryCcy = newCurrencyCode || entry.currencyCode || "USD";
        let fx: number;
        if (newFxRate) {
          fx = parseFloat(String(newFxRate)); // fresh explicit request input — trust it even if it equals 1
        } else {
          // factory_daybook_entries has no fxRateConfirmed column yet, so this still relies on
          // the legacy value-based heuristic (rate>0 && rate!==1) as a stopgap — a genuine
          // confirmed 1.0 rate stored directly on a daybook entry would be misflagged here.
          const { fxRate: resolvedFx, looksSet } = resolveStoredFxRate(entryCcy, entry.fxRateToUsd);
          if (!looksSet) throw new UnresolvedExchangeRateError(entryCcy);
          fx = resolvedFx;
        }
        const amtUsd = entryCcy === "USD" ? parsedAmount : parsedAmount * fx;
        const updatedMetaJson = JSON.stringify({ ...meta, containerId, sourceType });
        await tx
          .update(factoryDaybookEntries)
          .set({ amountCurrency: String(parsedAmount), amountUsd: String(amtUsd), metaJson: updatedMetaJson })
          .where(eq(factoryDaybookEntries.id, entryId));

        // ── 4. Sync OFFLOAD_RAW_STOCK daybook entry (total inclusive cost) ────────
        // This entry always shows the total cost of the container
        if (entry.txType !== "OFFLOAD_RAW_STOCK") {
          const [rawStockRow] = await tx
            .select({ id: factoryRawStock.id })
            .from(factoryRawStock)
            .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId!)));
          if (rawStockRow) {
            const containerCcy = container.currencyCode || "USD";
            const { fxRate: containerFx, looksSet: containerFxLooksSet } = resolveStoredFxRate(
              containerCcy,
              container.fxRateToUsd,
              (container as { fxRateConfirmed: boolean | undefined }).fxRateConfirmed
            );
            if (!containerFxLooksSet) throw new UnresolvedExchangeRateError(containerCcy);
            const totalUsd = containerCcy === "USD" ? totalCost : totalCost * containerFx;
            await tx
              .update(factoryDaybookEntries)
              .set({
                amountCurrency: String(totalCost.toFixed(4)),
                amountUsd: String(totalUsd.toFixed(4)),
                description: `Offloaded container ${container.containerNumber}: ${container.actualReceivedKg} kg at ${inclusiveCostPerKg.toFixed(4)}/kg (inclusive) [edited]`,
              })
              .where(
                and(
                  eq(factoryDaybookEntries.companyId, companyId),
                  eq(factoryDaybookEntries.txType, "OFFLOAD_RAW_STOCK"),
                  eq(factoryDaybookEntries.referenceId, rawStockRow.id)
                )
              );
          }
        }

        // ── 5. Audit record ───────────────────────────────────────────────────────
        await tx.insert(factoryDaybookEntryEdits).values({
          daybookEntryId: entryId,
          editedBy: userId,
          beforeJson,
          afterJson: JSON.stringify({ ...entry, amountCurrency: String(parsedAmount) }),
          reason: reason.trim(),
        });
      });

      // Return updated entry
      const [updated] = await db.select().from(factoryDaybookEntries).where(eq(factoryDaybookEntries.id, entryId));
      const [updatedContainer] = await db
        .select({
          id: factoryContainers.id,
          containerNumber: factoryContainers.containerNumber,
          finalPayableAmount: factoryContainers.finalPayableAmount,
          ratePerKgUsd: factoryContainers.ratePerKgUsd,
        })
        .from(factoryContainers)
        .where(eq(factoryContainers.id, containerId));

      res.json({
        entry: updated,
        container: updatedContainer,
        message: `Cost updated. New inclusive cost: ${updatedContainer?.ratePerKgUsd ?? "?"}/kg`,
      });
    } catch (error: unknown) {
      logger.error("Error in daybook cost-edit:", { error: error });
      const status = (error as { name?: string }).name === "UnresolvedExchangeRateError" ? 400 : 500;
      res.status(status).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE /api/factory/daybook/entry/:id — Hard delete a non-voucher-backed entry (admin/developer only)
  app.delete("/api/factory/daybook/entry/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const session = req.session;
      const companyId = session.factoryCompanyId || session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const role = (session.currentRole || session.role || "").toLowerCase();
      if (role !== "admin" && role !== "developer") {
        return res.status(403).json({ message: "Only Admin or Developer can permanently delete entries" });
      }
      const id = Number(req.params.id);
      if (isNaN(id) || id <= 0)
        return res
          .status(400)
          .json({ message: "Invalid entry ID — only real (non-synthetic) entries can be hard deleted" });

      const [entry] = await db
        .select()
        .from(factoryDaybookEntries)
        .where(and(eq(factoryDaybookEntries.id, id), eq(factoryDaybookEntries.companyId, companyId)));
      if (!entry) return res.status(404).json({ message: "Entry not found" });

      if (entry.referenceTable === "vouchers" && entry.referenceId) {
        return res.status(400).json({ message: "Voucher-backed entries must be voided, not deleted" });
      }

      await db.delete(factoryDaybookEntries).where(eq(factoryDaybookEntries.id, id));
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE /api/factory/daybook/entry/:id/void — Void a voucher-backed daybook entry
  app.delete("/api/factory/daybook/entry/:id/void", requireAuth, async (req: Request, res: Response) => {
    try {
      const session = req.session;
      const companyId = session.factoryCompanyId || session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const role = (session.currentRole || session.role || "").toLowerCase();
      if (role !== "admin" && role !== "owner" && role !== "developer") {
        return res.status(403).json({ message: "Only Admin or Owner can void vouchers" });
      }

      const rawId = Number(req.params.id);
      if (isNaN(rawId)) return res.status(400).json({ message: "Invalid entry ID" });

      let voucherId: number;
      let daybookEntryId: number | null = null;

      if (rawId < 0) {
        voucherId = Math.abs(rawId);
      } else {
        const [entry] = await db
          .select()
          .from(factoryDaybookEntries)
          .where(and(eq(factoryDaybookEntries.id, rawId), eq(factoryDaybookEntries.companyId, companyId)));
        if (!entry) return res.status(404).json({ message: "Daybook entry not found" });
        if (entry.referenceTable !== "vouchers" || !entry.referenceId) {
          return res.status(400).json({ message: "This entry is not voucher-backed and cannot be voided" });
        }
        voucherId = entry.referenceId;
        daybookEntryId = entry.id;
      }

      const [voucher] = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId), sql`${vouchers.deletedAt} IS NULL`));
      if (!voucher) return res.status(404).json({ message: "Voucher not found or already voided" });

      if (!["Payment", "Receipt", "Journal"].includes(voucher.voucherType)) {
        return res.status(400).json({ message: `Cannot void ${voucher.voucherType} vouchers from the daybook` });
      }

      const vNum = voucher.voucherNumber || "";
      const voucherTxTypeMap: Record<string, string> = { Payment: "PAYMENT", Receipt: "RECEIPT", Journal: "JOURNAL" };
      const txTypeVal = voucherTxTypeMap[voucher.voucherType] || "JOURNAL";
      const today = getClientDate(req);

      await db.transaction(async (tx) => {
        // 0. Read employee-linked entries BEFORE deletion so we can reverse balances
        const empEntries = await tx
          .select()
          .from(voucherEntries)
          .where(and(eq(voucherEntries.voucherId, voucherId), sql`${voucherEntries.employeeId} IS NOT NULL`));

        // 1. Delete voucher entries (double-entry lines)
        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));

        // 2. Soft-delete the voucher
        await tx.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, voucherId));

        // 3. Delete the real daybook entry if it exists
        if (daybookEntryId) {
          await tx.delete(factoryDaybookEntries).where(eq(factoryDaybookEntries.id, daybookEntryId));
        }

        // 4. Cascade effects based on voucher number pattern
        const advPayMatch = vNum.match(/^PAYMENT-ADV-(\d+)-/);
        const payPayMatch = vNum.match(/^PAYMENT-PAY-(\d+)-/);
        const repayMatch = vNum.match(/^RECEIPT-REPAY-(\d+)-/);

        if (advPayMatch) {
          const advanceId = parseInt(advPayMatch[1]);
          await tx
            .update(factoryWorkerAdvances)
            .set({ cashAccountId: null })
            .where(and(eq(factoryWorkerAdvances.id, advanceId), eq(factoryWorkerAdvances.companyId, companyId)));
        } else if (payPayMatch) {
          const payrollId = parseInt(payPayMatch[1]);
          const [payroll] = await tx
            .select()
            .from(factoryPayrolls)
            .where(and(eq(factoryPayrolls.id, payrollId), eq(factoryPayrolls.companyId, companyId)));

          await tx
            .update(factoryPayrolls)
            .set({ status: "DRAFT", cashAccountId: null, paidAt: null })
            .where(and(eq(factoryPayrolls.id, payrollId), eq(factoryPayrolls.companyId, companyId)));

          if (payroll) {
            const advAmt = parseFloat(payroll.advances || "0");
            if (advAmt > 0) {
              const workerAdvances = await tx
                .select()
                .from(factoryWorkerAdvances)
                .where(
                  and(
                    eq(factoryWorkerAdvances.companyId, companyId),
                    eq(factoryWorkerAdvances.workerId, payroll.workerId),
                    eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
                  )
                )
                .orderBy(desc(factoryWorkerAdvances.advanceDate));

              let toRestore = advAmt;
              for (const adv of workerAdvances) {
                if (toRestore <= 0) break;
                const bal = parseFloat(adv.remainingBalance || "0");
                const originalAmt = parseFloat(adv.amount || "0");
                const room = originalAmt - bal;
                if (room <= 0) continue;
                const restoreAmt = Math.min(room, toRestore);
                const newBal = bal + restoreAmt;
                await tx
                  .update(factoryWorkerAdvances)
                  .set({
                    remainingBalance: newBal.toFixed(2),
                    fullyPaid: false,
                  })
                  .where(eq(factoryWorkerAdvances.id, adv.id));
                toRestore -= restoreAmt;
              }
            }
          }
        } else if (repayMatch) {
          const repaymentId = parseInt(repayMatch[1]);
          const [repayment] = await tx
            .select()
            .from(factoryAdvanceRepayments)
            .where(
              and(eq(factoryAdvanceRepayments.id, repaymentId), eq(factoryAdvanceRepayments.companyId, companyId))
            );
          if (repayment) {
            const [advance] = await tx
              .select()
              .from(factoryWorkerAdvances)
              .where(
                and(eq(factoryWorkerAdvances.id, repayment.advanceId), eq(factoryWorkerAdvances.companyId, companyId))
              );
            if (advance) {
              const newBalance = parseFloat(advance.remainingBalance || "0") + parseFloat(repayment.amount || "0");
              await tx
                .update(factoryWorkerAdvances)
                .set({
                  remainingBalance: newBalance.toFixed(2),
                  fullyPaid: false,
                })
                .where(eq(factoryWorkerAdvances.id, advance.id));
            }
            await tx.delete(factoryAdvanceRepayments).where(eq(factoryAdvanceRepayments.id, repaymentId));
          }
        }

        // 4b. Reverse employee balance/deposit/withdrawal for EMP-DEP, EMP-WD, EMP-PAY vouchers
        if (
          empEntries.length > 0 &&
          (vNum.startsWith("EMP-DEP-") || vNum.startsWith("EMP-WD-") || vNum.startsWith("EMP-PAY-"))
        ) {
          // Group deltas by employeeId
          const empDeltas = new Map<number, { creditTotal: number; debitTotal: number }>();
          for (const entry of empEntries) {
            const empId = entry.employeeId as number;
            const cr = parseFloat(entry.creditAmount || "0");
            const dr = parseFloat(entry.debitAmount || "0");
            if (!empDeltas.has(empId)) empDeltas.set(empId, { creditTotal: 0, debitTotal: 0 });
            const d = empDeltas.get(empId)!;
            d.creditTotal += cr;
            d.debitTotal += dr;
          }
          for (const [empId, delta] of empDeltas) {
            const [emp] = await tx
              .select()
              .from(employees)
              .where(and(eq(employees.id, empId), eq(employees.companyId, companyId)));
            if (!emp) continue;
            const curBal = parseFloat(emp.currentBalance || "0");
            const curDep = parseFloat(emp.totalDeposits || "0");
            const curWith = parseFloat(emp.totalWithdrawals || "0");
            // CR entries = deposits (balance went up) → reverse: subtract
            // DR entries = withdrawals/deductions (balance went down) → reverse: add back
            const newBal = curBal - delta.creditTotal + delta.debitTotal;
            const newDep = Math.max(0, curDep - delta.creditTotal);
            const newWith = Math.max(0, curWith - delta.debitTotal);
            await tx
              .update(employees)
              .set({
                currentBalance: newBal.toFixed(2),
                totalDeposits: newDep.toFixed(2),
                ...(delta.debitTotal > 0 ? { totalWithdrawals: newWith.toFixed(2) } : {}),
              })
              .where(eq(employees.id, empId));
          }
        }

        // 5. Write a VOIDED audit daybook entry (no voucher reference so it won't be filtered by soft-delete logic)
        const voidTxType = `${txTypeVal}_VOIDED`;
        const amt = parseFloat(voucher.totalAmount || "0");
        const currency = voucher.currency || "USD";
        const fxRate = parseFloat(voucher.exchangeRate || "1") || 1;
        const amtUsd = currency === "USD" ? amt : amt * fxRate;
        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: voidTxType,
          description: `VOIDED: ${voucher.description || voucher.voucherNumber} (voucher #${voucherId})`,
          currencyCode: currency,
          amountCurrency: amt,
          fxRateToUsd: fxRate,
          amountUsd: amtUsd,
          createdBy: session.userId || undefined,
        });
      });

      res.json({ message: "Voucher voided successfully", voucherId });
    } catch (error: unknown) {
      logger.error("Error voiding voucher:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
