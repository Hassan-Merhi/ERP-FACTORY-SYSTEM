/**
 * rentalUnitsContractsRoutes: RentalUnitsWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { RentalRoutesContext } from "./_helpers";
import type { Express, Request, Response } from "express";
import { getErrorMessage, translateDatabaseError } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getCompanyId } from "../shared";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { propertyUnits, propertyContracts, insertPropertyUnitSchema } from "@shared/schema";
import { parseId } from "../../../lib/parseId";
import { logAudit } from "../../_helpers";
import { requireCreateOnlyVerifiedCreate } from "../../../services/security/createOnlyVerifiedCreates";

export function registerRentalUnitsWriteRoutes(app: Express, ctx: RentalRoutesContext) {
  const { module, urlPrefix } = ctx;
  // ── CREATE unit ──
  app.post(
    `${urlPrefix}/units`,
    requireAuth,
    requireCreateOnlyVerifiedCreate("rentalUnits"),
    async (req: Request, res: Response) => {
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
        const dbError = e && typeof e === "object" && "cause" in e && e.cause
          ? e.cause
          : e;
        const pg = dbError && typeof dbError === "object"
          ? dbError as { code?: string; constraint?: string; message?: string }
          : {};
        // Drizzle's outer "Failed query" message hides the PostgreSQL reason.
        // Log the inner reason server-side, not the SQL statement in the toast.
        logger.error("[rental] Could not create rental unit", {
          module,
          code: pg.code,
          constraint: pg.constraint,
          reason: pg.message ?? getErrorMessage(e),
        });
        if (pg.code === "23505" && (pg.constraint === "property_units_pkey" ||
            pg.constraint === "property_units_company_module_unit_unique")) {
          return res.status(409).json({
            message: pg.constraint === "property_units_pkey"
              ? "The shop ID sequence needs repair. Please contact an administrator."
              : "A shop with this unit number already exists in this company.",
          });
        }
        if (pg.code === "42703" || pg.code === "42P01") {
          return res.status(503).json({
            message: "The rental database schema is out of date. Please deploy the rental schema repair.",
          });
        }
        const translated = translateDatabaseError(e);
        if (translated) return res.status(translated.statusCode).json({ message: translated.message });
        res.status(500).json({
          message: "Could not create the shop. The server logged the database error; please contact an administrator.",
        });
      }
    }
  );

  // ── PATCH unit ──
  app.patch(`${urlPrefix}/units/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      // A location heading is stored on units, not in a separate group table.
      // Rename every matching unit atomically; never modify leases, ledgers, or vouchers.
      if (req.body?.renameGroup === true) {
        const requestedName = req.body.locationGroup;
        if (typeof requestedName !== "string") {
          return res.status(400).json({ message: "A location group name is required" });
        }
        const locationGroup = requestedName.trim().toUpperCase();
        if (!locationGroup || locationGroup.length > 120) {
          return res.status(400).json({ message: "Location group name must be 1-120 characters" });
        }

        const [anchor] = await db
          .select()
          .from(propertyUnits)
          .where(
            and(eq(propertyUnits.id, id), eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, module))
          );
        if (!anchor) return res.status(404).json({ message: "Unit not found" });
        const previousGroup = anchor.locationGroup;
        if (locationGroup === previousGroup) return res.json({ locationGroup, updatedCount: 0 });

        const result = await db.transaction(async (tx) => {
          const scope = and(
            eq(propertyUnits.companyId, companyId),
            eq(propertyUnits.module, module),
            eq(propertyUnits.unitType, anchor.unitType)
          );
          const collision = await tx
            .select({ id: propertyUnits.id })
            .from(propertyUnits)
            .where(and(scope, eq(propertyUnits.locationGroup, locationGroup)))
            .limit(1);
          if (collision.length) return { conflict: true as const };

          const updated = await tx
            .update(propertyUnits)
            .set({ locationGroup })
            .where(and(scope, eq(propertyUnits.locationGroup, previousGroup)))
            .returning({ id: propertyUnits.id, unitNumber: propertyUnits.unitNumber });
          for (const unit of updated) {
            await logAudit(
              {
                userId: req.session.userId!,
                username: req.session.username || "unknown",
                companyId,
                action: "update",
                tableName: "property_units",
                recordId: unit.id,
                recordIdentifier: unit.unitNumber,
                changes: { locationGroup: { old: previousGroup, new: locationGroup } },
              },
              tx
            );
          }
          return { conflict: false as const, updatedCount: updated.length };
        });
        if (result.conflict) {
          return res.status(409).json({ message: "This location group already exists. Choose another name." });
        }
        return res.json({ locationGroup, updatedCount: result.updatedCount });
      }

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
