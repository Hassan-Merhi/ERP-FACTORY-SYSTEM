/**
 * rentalUnitsContractsRoutes: RentalContract endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getCompanyId, ensureMonthlyLedgerRows } from "../shared";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { propertyUnits, propertyContracts, insertPropertyContractSchema } from "@shared/schema";
import { parseId } from "../../../lib/parseId";
import { logAudit } from "../../_helpers";

export function registerRentalContractRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix, tag } = ctx;
  // ── START CONTRACT ──
  app.post(`${urlPrefix}/contracts`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const data = insertPropertyContractSchema.parse({ ...req.body, companyId });

      const [unit] = await db
        .select()
        .from(propertyUnits)
        .where(
          and(
            eq(propertyUnits.id, data.unitId),
            eq(propertyUnits.companyId, companyId),
            eq(propertyUnits.module, module)
          )
        );
      if (!unit) return res.status(404).json({ message: "Unit not found" });

      const [existing] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module),
            eq(propertyContracts.unitId, data.unitId),
            eq(propertyContracts.status, "ACTIVE")
          )
        );
      if (existing) return res.status(400).json({ message: "Unit already has an active contract" });

      const [created] = await db
        .insert(propertyContracts)
        .values({ ...data, module })
        .returning();
      await ensureMonthlyLedgerRows(created.id);
      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || "unknown",
        companyId,
        action: "create",
        tableName: "property_contracts",
        recordId: created.id,
        recordIdentifier: `Contract#${created.id} Unit#${created.unitId}`,
        changes: {
          unitId: { old: null, new: created.unitId },
          rentalAmount: { old: null, new: created.rentalAmount },
          startDate: { old: null, new: created.startDate },
        },
      });
      res.json(created);
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      logger.error(`${tag} contracts:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── MODIFY RENT ──
  app.patch(`${urlPrefix}/contracts/:id/rent`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { newAmount, effectiveFrom } = z
        .object({
          newAmount: z.union([z.string(), z.number()]).transform((v) => String(v)),
          effectiveFrom: z.enum(["current", "next"]).default("current"),
        })
        .parse(req.body);

      const [contract] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.id, id),
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module)
          )
        );
      if (!contract) return res.status(404).json({ message: "Contract not found" });

      await db.update(propertyContracts).set({ rentalAmount: newAmount }).where(eq(propertyContracts.id, id));

      const now = new Date();
      let y = now.getUTCFullYear(),
        m = now.getUTCMonth() + 1;
      if (effectiveFrom === "next") {
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }

      await db.execute(sql`
        UPDATE property_monthly_ledger
        SET expected_amount = ${newAmount}
        WHERE contract_id = ${id} AND paid_amount = 0
          AND ((year > ${y}) OR (year = ${y} AND month >= ${m}))
      `);

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "update",
          tableName: "property_contracts",
          recordId: id,
          recordIdentifier: `Contract#${id} Unit#${contract.unitId}`,
          changes: {
            rentalAmount: { old: contract.rentalAmount ?? null, new: newAmount },
            rentEffectiveFrom: { old: null, new: effectiveFrom },
          },
        });
      } catch (auditErr) {
        logger.error("[contract rent-update audit] non-fatal:", { error: auditErr });
      }

      res.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── EDIT CONTRACT INFO (tenant name + start date) ──
  app.patch(`${urlPrefix}/contracts/:id/info`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { tenantName, startDate, guaranteeAmount, guaranteePeriod, isInternal, linkedCompanyId } = z
        .object({
          tenantName: z.string().min(1, "Tenant name required"),
          startDate: z.string().min(1, "Start date required"),
          guaranteeAmount: z.string().optional(),
          guaranteePeriod: z.string().optional(),
          isInternal: z.boolean().optional(),
          linkedCompanyId: z.number().nullable().optional(),
        })
        .parse(req.body);
      const [contract] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.id, id),
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module)
          )
        );
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      const contractUpdates: Partial<typeof propertyContracts.$inferInsert> = { tenantName, startDate };
      if (guaranteeAmount !== undefined) contractUpdates.guaranteeAmount = guaranteeAmount;
      if (guaranteePeriod !== undefined) contractUpdates.guaranteePeriod = guaranteePeriod;
      if (isInternal !== undefined) contractUpdates.isInternal = isInternal;
      if (linkedCompanyId !== undefined) contractUpdates.linkedCompanyId = linkedCompanyId;
      await db.update(propertyContracts).set(contractUpdates).where(eq(propertyContracts.id, id));

      // Clean up ledger rows that are now before the new start date
      const newStart = new Date(startDate);
      const newStartYear = newStart.getUTCFullYear();
      const newStartMonth = newStart.getUTCMonth() + 1;

      // Delete rows before the new start date that have no payments (zero or null paidAmount)
      await db.execute(sql`
        DELETE FROM property_monthly_ledger
        WHERE contract_id = ${id}
          AND (year < ${newStartYear} OR (year = ${newStartYear} AND month < ${newStartMonth}))
          AND (paid_amount IS NULL OR paid_amount::numeric = 0)
      `);

      // Zero out expected amount for rows before the new start date that DO have payments
      // (they become pure credit entries rather than appearing as unpaid obligations)
      await db.execute(sql`
        UPDATE property_monthly_ledger
        SET expected_amount = 0
        WHERE contract_id = ${id}
          AND (year < ${newStartYear} OR (year = ${newStartYear} AND month < ${newStartMonth}))
          AND paid_amount::numeric > 0
      `);

      // Restore expected_amount for any paid months AT or AFTER the new start date
      // that were accidentally zeroed by a previous start-date change.
      // We set expected_amount = paid_amount so the month shows outstanding = $0
      // (the tenant paid what they owed; the zeroed expected was a data inconsistency).
      await db.execute(sql`
        UPDATE property_monthly_ledger
        SET expected_amount = paid_amount
        WHERE contract_id = ${id}
          AND (year > ${newStartYear} OR (year = ${newStartYear} AND month >= ${newStartMonth}))
          AND expected_amount::numeric = 0
          AND paid_amount::numeric > 0
      `);

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "update",
          tableName: "property_contracts",
          recordId: id,
          recordIdentifier: `Contract#${id} Unit#${contract.unitId}`,
          changes: {
            ...(tenantName !== contract.tenantName
              ? { tenantName: { old: contract.tenantName ?? null, new: tenantName } }
              : {}),
            ...(startDate !== contract.startDate
              ? { startDate: { old: contract.startDate ?? null, new: startDate } }
              : {}),
            ...(guaranteeAmount !== undefined
              ? { guaranteeAmount: { old: contract.guaranteeAmount ?? null, new: guaranteeAmount } }
              : {}),
          },
        });
      } catch (auditErr) {
        logger.error("[contract info-update audit] non-fatal:", { error: auditErr });
      }

      res.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
