// Extracted from ./daybookEditRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import { emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import { factoryDaybookEntries, factoryDaybookEntryEdits, vouchers } from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import {
  editPostedFactoryVoucherTx,
  sendVoucherCorrectionRefusal,
} from "../../../services/factory/factoryVoucherCorrection";
import { voucherFxRate } from "./daybookEditPolicy";

// entryId may be negative (a voucher-backed synthetic row); the handler parses it.
// The handler checks the reason itself; amounts go through String().
const numeric = z.union([z.string(), z.number()]);
const editEntryInput = {
  params: z.strictObject({ entryId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    reason: z.string().optional(),
    description: z.string().optional(),
    amountCurrency: numeric.optional(),
    amountUsd: numeric.optional(),
    currencyCode: z.string().optional(),
    fxRateToUsd: numeric.optional(),
    txDate: z.string().optional(),
  }),
} satisfies RequestSchemas;

export function registerFactoryDaybookEditRoutesPart1(app: Express) {
  // ─────── DAYBOOK ENTRY EDIT ───────

  app.put(
    "/api/factory/daybook/:entryId",
    requireAuth,
    validateRequest(editEntryInput),
    async (req: Request, res: Response) => {
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

          const voucherTxTypeMap: Record<string, string> = {
            Payment: "PAYMENT",
            Receipt: "RECEIPT",
            Journal: "JOURNAL",
          };
          const txTypeVal = voucherTxTypeMap[sourceVoucher.voucherType] || "JOURNAL";
          const currency = sourceVoucher.currency || "USD";
          const fxRate = voucherFxRate(sourceVoucher.exchangeRate);
          const amtCurrency = toMoney(sourceVoucher.totalAmount);
          const amtUsd = currency === "USD" ? amtCurrency : amtCurrency.times(fxRate);

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
              amountCurrency: amtCurrency.toFixed(2),
              fxRateToUsd: fxRate.toFixed(),
              amountUsd: amtUsd.toFixed(2),
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

        // Posted bonus Daybook rows are immutable accounting evidence.
        // Reversal is the only supported correction path for these entries.
        if (
          existing.txType.startsWith("PRODUCTION_TARGET_BONUS_") ||
          existing.txType.startsWith("PRODUCTION_TARGET_WEEKLY_BONUS_")
        ) {
          return res
            .status(409)
            .json({ message: "Posted bonus Daybook entries cannot be edited. Reverse the payment instead." });
        }

        const beforeJson = JSON.stringify(existing);

        const updates: PgUpdateSetSource<typeof factoryDaybookEntries> = {};
        if (description !== undefined) updates.description = description;
        if (amountCurrency !== undefined) updates.amountCurrency = String(amountCurrency);
        if (amountUsd !== undefined) updates.amountUsd = String(amountUsd);
        if (currencyCode !== undefined) updates.currencyCode = currencyCode;
        if (fxRateToUsd !== undefined) updates.fxRateToUsd = String(fxRateToUsd);
        if (txDate !== undefined) updates.txDate = txDate;

        // Phase 22 (C): the daybook edit, its edit record and the source voucher's
        // sync commit together; a voucher date change is an edit of the posted
        // voucher (refused with 409 in a closed period — reverse instead —
        // audited before/after otherwise). A description-only sync stays a plain
        // header change (the correction policy allows it).
        const updated = await db.transaction(async (tx) => {
          const [row] = await tx
            .update(factoryDaybookEntries)
            .set(updates)
            .where(eq(factoryDaybookEntries.id, realEntryId))
            .returning();
          await tx.insert(factoryDaybookEntryEdits).values({
            daybookEntryId: realEntryId,
            editedBy: userId,
            beforeJson,
            afterJson: JSON.stringify(row),
            reason: reason.trim(),
          });

          // ── Sync description and date back to the source voucher so Accounts statements stay in sync ──
          if (row.referenceTable === "vouchers" && row.referenceId) {
            const sourceVoucherId = row.referenceId;
            const voucherUpdates: PgUpdateSetSource<typeof vouchers> = {};
            if (description !== undefined) voucherUpdates.description = description;
            if (txDate !== undefined) voucherUpdates.voucherDate = txDate;
            const applyVoucherUpdates = () =>
              tx
                .update(vouchers)
                .set(voucherUpdates)
                .where(and(eq(vouchers.id, sourceVoucherId), eq(vouchers.companyId, companyId)));
            if (txDate !== undefined) {
              await editPostedFactoryVoucherTx(
                tx,
                {
                  companyId,
                  voucherIds: [sourceVoucherId],
                  reason: `factory-daybook-edit: ${reason.trim()}`,
                  actor: { userId, username: req.session.username },
                  newVoucherDate: txDate,
                },
                applyVoucherUpdates
              );
            } else if (Object.keys(voucherUpdates).length > 0) {
              await applyVoucherUpdates();
            }
          }
          return row;
        });

        res.json(updated);
      } catch (error: unknown) {
        if (sendVoucherCorrectionRefusal(res, error)) return;
        logger.error("Error editing daybook entry:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

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
}
