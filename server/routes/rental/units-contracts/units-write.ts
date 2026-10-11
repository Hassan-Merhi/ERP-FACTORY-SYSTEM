/**
 * rentalUnitsContractsRoutes: RentalUnitsWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { getCompanyId } from "../shared";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { propertyUnits, propertyContracts, insertPropertyUnitSchema } from "@shared/schema";
import { parseId } from "../../../lib/parseId";
import { logAudit } from "../../_helpers";

export function registerRentalUnitsWriteRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix } = ctx;
  // ── CREATE unit ──
  app.post(`${urlPrefix}/units`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const data = insertPropertyUnitSchema.parse({ ...req.body, companyId });
      // Phase 21 (B): the write and its audit commit together.
      const created = await db.transaction(async (tx) => {
        const [written] = await tx
          .insert(propertyUnits)
          .values({ ...data, module })
          .returning();
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "create",
            tableName: "property_units",
            recordId: written.id,
            recordIdentifier: written.unitNumber || String(written.id),
            changes: { unitNumber: { old: null, new: written.unitNumber } },
          },
          tx
        );
        return written;
      });
      res.json(created);
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── PATCH unit ──
  app.patch(`${urlPrefix}/units/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const allowed = ["unitNumber", "size", "dimensions", "locationGroup", "notes", "sortOrder", "active"];
      const updates: Partial<typeof propertyUnits.$inferInsert> = {};
      for (const k of allowed) if (k in req.body) Object.assign(updates, { [k]: req.body[k] });

      const [existing] = await db
        .select()
        .from(propertyUnits)
        .where(and(eq(propertyUnits.id, id), eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, module)));
      if (!existing) return res.status(404).json({ message: "Unit not found" });

      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(propertyUnits)
          .set(updates)
          .where(
            and(eq(propertyUnits.id, id), eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, module))
          )
          .returning();

        const changes: Record<string, { old: unknown; new: unknown }> = {};
        for (const k of Object.keys(updates)) {
          changes[k] = {
            old: (existing as Record<string, unknown>)[k] ?? null,
            new: (updates as Record<string, unknown>)[k],
          };
        }
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "update",
            tableName: "property_units",
            recordId: id,
            recordIdentifier: existing.unitNumber || String(id),
            changes,
          },
          tx
        );
        return written;
      });

      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── DELETE unit ──
  app.delete(`${urlPrefix}/units/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [active] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module),
            eq(propertyContracts.unitId, id),
            eq(propertyContracts.status, "ACTIVE")
          )
        );
      if (active)
        return res.status(400).json({ message: "Cannot delete: unit has active contract. End contract first." });

      const [unitToDelete] = await db
        .select({ unitNumber: propertyUnits.unitNumber })
        .from(propertyUnits)
        .where(and(eq(propertyUnits.id, id), eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, module)));

      // Phase 21 (B): the write and its audit commit together.
      await db.transaction(async (tx) => {
        await tx
          .update(propertyUnits)
          .set({ active: false })
          .where(
            and(eq(propertyUnits.id, id), eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, module))
          );

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "delete",
            tableName: "property_units",
            recordId: id,
            recordIdentifier: unitToDelete?.unitNumber || String(id),
            changes: { active: { old: true, new: false } },
          },
          tx
        );
      });

      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
