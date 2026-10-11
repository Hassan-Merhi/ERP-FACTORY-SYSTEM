/**
 * containerAccountingRoutes: ContainerNumber endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { containers, voucherEntries, vouchers } from "@shared/schema";
import { and, eq, exists, inArray, like, or, sql } from "drizzle-orm";
import { writeAuditEvent } from "../../../services/audit";
import { sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { companyClosedThrough, isDateInClosedPeriod } from "../../../services/accounting/scheduledPostingScope";

export function registerContainerNumberRoutes(app: Express) {
  app.patch("/api/containers/:id/number", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid container ID" });
      const { containerNumber } = req.body;
      if (!containerNumber || !String(containerNumber).trim()) {
        return res.status(400).json({ message: "Container number is required" });
      }
      const newNumber = String(containerNumber).trim().toUpperCase();
      const [existing] = await db
        .select({ id: containers.id })
        .from(containers)
        .where(and(eq(containers.companyId, companyId), eq(containers.containerNumber, newNumber)))
        .limit(1);
      if (existing && existing.id !== id) {
        return res.status(409).json({ message: `Container number "${newNumber}" is already in use` });
      }
      // Phase 19 (A), G19/DI9: the rename and the rewrite of the voucher
      // descriptions and line narrations that mention the old number (the
      // supplier ledger finds the container by its number in the text) are one
      // transaction, this company's vouchers only, refused when one of them is
      // dated in a closed period, with one audit row of every text before and
      // after. The rewrite ran over every company's vouchers and swallowed its
      // error, leaving the container renamed and the vouchers not.
      const actor = sessionRetirementActor(req);
      const outcome = await db.transaction(async (tx) => {
        const [currentRow] = await tx
          .select({ containerNumber: containers.containerNumber })
          .from(containers)
          .where(and(eq(containers.id, id), eq(containers.companyId, companyId)))
          .limit(1)
          .for("update");
        if (!currentRow) return { notFound: true as const };
        const oldNumber = currentRow.containerNumber;
        const pattern = "%" + oldNumber + "%";
        const changed = oldNumber && oldNumber !== newNumber;

        const affected = changed
          ? await tx
              .select({
                id: vouchers.id,
                voucherNumber: vouchers.voucherNumber,
                voucherDate: vouchers.voucherDate,
                effectiveDate: vouchers.effectiveDate,
                description: vouchers.description,
              })
              .from(vouchers)
              .where(
                and(
                  eq(vouchers.companyId, companyId),
                  or(
                    like(vouchers.description, pattern),
                    exists(
                      tx
                        .select({ one: sql`1` })
                        .from(voucherEntries)
                        .where(and(eq(voucherEntries.voucherId, vouchers.id), like(voucherEntries.narration, pattern)))
                    )
                  )
                )
              )
              .orderBy(vouchers.id)
              .for("update")
          : [];
        const closedThrough = await companyClosedThrough(companyId, tx);
        const closed = affected.filter(
          (v) =>
            isDateInClosedPeriod(closedThrough, String(v.voucherDate)) ||
            isDateInClosedPeriod(closedThrough, String(v.effectiveDate ?? v.voucherDate))
        );
        if (closed.length) return { closed: closed.map((v) => v.voucherNumber), closedThrough };

        const voucherIds = affected.map((v) => v.id);
        const lines = voucherIds.length
          ? await tx
              .select({
                id: voucherEntries.id,
                voucherId: voucherEntries.voucherId,
                narration: voucherEntries.narration,
              })
              .from(voucherEntries)
              .where(and(inArray(voucherEntries.voucherId, voucherIds), like(voucherEntries.narration, pattern)))
              .orderBy(voucherEntries.id)
          : [];

        const [updated] = await tx
          .update(containers)
          .set({ containerNumber: newNumber })
          .where(and(eq(containers.id, id), eq(containers.companyId, companyId)))
          .returning();

        if (voucherIds.length) {
          await tx
            .update(vouchers)
            .set({ description: sql`REPLACE(${vouchers.description}, ${oldNumber}, ${newNumber})` })
            .where(
              and(
                eq(vouchers.companyId, companyId),
                inArray(vouchers.id, voucherIds),
                like(vouchers.description, pattern)
              )
            );
        }
        if (lines.length) {
          await tx
            .update(voucherEntries)
            .set({ narration: sql`REPLACE(${voucherEntries.narration}, ${oldNumber}, ${newNumber})` })
            .where(
              inArray(
                voucherEntries.id,
                lines.map((line) => line.id)
              )
            );
        }

        if (changed) {
          await writeAuditEvent(
            {
              userId: actor.userId,
              username: actor.username,
              companyId,
              action: "update",
              tableName: "containers",
              recordId: id,
              recordIdentifier: newNumber,
              changes: {
                containerNumber: { old: oldNumber, new: newNumber },
                voucherDescriptions: {
                  old: affected
                    .filter((v) => (v.description ?? "").includes(oldNumber))
                    .map((v) => ({ voucherId: v.id, voucherNumber: v.voucherNumber, description: v.description })),
                },
                lines: {
                  old: lines.map((line) => ({ id: line.id, voucherId: line.voucherId, narration: line.narration })),
                  new: lines.map((line) => ({
                    id: line.id,
                    voucherId: line.voucherId,
                    narration: (line.narration ?? "").split(oldNumber).join(newNumber),
                  })),
                },
              },
            },
            tx
          );
        }
        return { updated };
      });

      if ("notFound" in outcome) return res.status(404).json({ message: "Container not found" });
      if ("closed" in outcome && outcome.closed) {
        const closedVouchers = outcome.closed.join(", ");
        return res.status(409).json({
          code: "CONTAINER_NUMBER_CLOSED_PERIOD",
          message: `Container number cannot be changed: vouchers that mention it are in a closed period (closed through ${outcome.closedThrough}): ${closedVouchers}`,
          vouchers: outcome.closed,
        });
      }
      const { updated } = outcome;
      if (!updated) return res.status(404).json({ message: "Container not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error renaming container:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
