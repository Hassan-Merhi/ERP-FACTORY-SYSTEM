// Extracted from ./locationCrudRoutes.ts
import { getErrorDetails } from "@shared/errorUtils";
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth, checkPOSLocation } from "../../auth";
import { logAudit } from "../_helpers";
import { locations, insertLocationSchema } from "@shared/schema";
import { eq } from "drizzle-orm";
import { parseMoneyInput } from "../../lib/money";

export type LocationWhatsAppSettings = {
  whatsappGroupChatId: string | null;
  whatsappGroupName: string | null;
  whatsappStockReportsEnabled: boolean;
};

export async function getLocationWhatsAppSettingsMap(
  companyId: number
): Promise<Map<number, LocationWhatsAppSettings>> {
  try {
    const result = await pool.query(
      `SELECT location_id, whatsapp_group_chat_id, whatsapp_group_name, enabled
         FROM location_whatsapp_stock_reports
        WHERE company_id = $1`,
      [companyId]
    );
    return new Map(
      result.rows.map((row) => [
        Number(row.location_id),
        {
          whatsappGroupChatId: row.whatsapp_group_chat_id ?? null,
          whatsappGroupName: row.whatsapp_group_name ?? null,
          whatsappStockReportsEnabled: row.enabled === true,
        },
      ])
    );
  } catch (error) {
    // Startup migrations create this table before routes are served. Keeping the
    // fallback makes older test fixtures and partially migrated dev databases
    // readable instead of turning the whole Location Inventory page into a 500.
    if (getErrorDetails(error).code === "42P01") return new Map();
    throw error;
  }
}

export function withLocationWhatsAppSettings(location: Record<string, unknown>, settings?: LocationWhatsAppSettings) {
  const legacyChatId = location.whatsappGroupChatId ?? null;
  return {
    ...location,
    whatsappGroupChatId: settings?.whatsappGroupChatId ?? legacyChatId,
    whatsappGroupName: settings?.whatsappGroupName ?? null,
    whatsappStockReportsEnabled: settings?.whatsappStockReportsEnabled ?? Boolean(legacyChatId),
  };
}

export function registerLocationCrudRoutesPart1(app: Express) {
  app.post("/api/locations", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const parsed = insertLocationSchema.parse({
        ...req.body,
        companyId: req.session.currentCompanyId,
      });

      // `locations.code` is globally unique, but a tenant-scoped connection
      // must not read another company's locations to find a free code.
      // Namespace generated codes by the authenticated company ID, preserve
      // historic codes, and still check collisions inside this company.
      if (!parsed.code) {
        const sanitized = parsed.name.trim().replace(/[^a-zA-Z0-9]/g, "");
        const baseCode = `C${req.session.currentCompanyId}-${sanitized.substring(0, 6).toUpperCase() || "LOC"}`;
        let code = baseCode;
        let suffix = 1;
        while (await storage.getLocationByCode(code, req.session.currentCompanyId)) {
          code = `${baseCode}${suffix}`;
          suffix++;
        }
        parsed.code = code;
      } else {
        const existing = await storage.getLocationByCode(parsed.code, req.session.currentCompanyId);
        if (existing) {
          return res.status(409).json({ message: "Location code already exists. Choose another code or name." });
        }
      }

      // Provide defaults for optional fields
      const locationData = {
        ...parsed,
        code: parsed.code!,
        city: parsed.city || "",
        state: parsed.state || "",
        country: parsed.country || "",
      };

      // Phase 21 (B): the write and its audit commit together.
      const location = await db.transaction(async (tx) => {
        const written = await storage.createLocation(locationData, tx);
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "create",
            tableName: "locations",
            recordId: written.id,
            recordIdentifier: written.name,
            changes: {
              name: { old: null, new: written.name },
              code: { old: null, new: written.code },
              city: { old: null, new: written.city || null },
              state: { old: null, new: written.state || null },
              country: { old: null, new: written.country || null },
            },
          },
          tx
        );
        return written;
      });
      res.status(201).json(location);
    } catch (error: unknown) {
      // Drizzle wraps PostgreSQL errors in `cause`. Keep SQL and parameter
      // values in the server logs, never in the browser toast/HTTP response.
      const details = getErrorDetails(error);
      const cause =
        typeof error === "object" && error !== null && "cause" in error ? getErrorDetails(error.cause) : undefined;
      const pgCode = cause?.code ?? details.code;
      logger.error("[POST /api/locations] Location creation failed", {
        error,
        companyId: req.session.currentCompanyId,
        pgCode,
      });
      if (details.name === "ZodError") {
        return res.status(400).json({ message: "Invalid location information. Please check the name and try again." });
      }
      if (pgCode === "23505") {
        return res.status(409).json({ message: "That location code is already in use. Try again." });
      }
      if (pgCode === "42703" || pgCode === "42P01") {
        return res.status(503).json({
          message: "The location database schema needs an administrator update.",
          code: "LOCATION_SCHEMA_OUTDATED",
        });
      }
      return res.status(500).json({
        message: "Location could not be created. Please contact an administrator.",
        code: "LOCATION_CREATE_FAILED",
      });
    }
  });

  // Get single location by ID
  app.get("/api/locations/:locationId", requireAuth, checkPOSLocation, async (req, res) => {
    try {
      const locationId = parseInt(req.params.locationId);
      if (isNaN(locationId)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }

      const location = await storage.getLocationById(locationId);
      if (!location) {
        return res.status(404).json({ message: "Location not found" });
      }

      // Verify location belongs to current company
      if (location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Location belongs to a different company",
        });
      }

      const settingsMap = await getLocationWhatsAppSettingsMap(location.companyId);
      res.json(withLocationWhatsAppSettings(location, settingsMap.get(location.id)));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Rename (update) location. WhatsApp destination changes intentionally use the
  // dedicated permission-protected endpoint below so this generic route cannot
  // be used to bypass the location WhatsApp management permission.
  app.patch("/api/locations/:locationId", requireAuth, async (req, res) => {
    try {
      const locationId = parseInt(req.params.locationId);
      if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

      const location = await storage.getLocationById(locationId);
      if (!location) return res.status(404).json({ message: "Location not found" });
      if (location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      if (
        req.body.whatsappGroupChatId !== undefined ||
        req.body.whatsappGroupName !== undefined ||
        req.body.whatsappStockReportsEnabled !== undefined
      ) {
        return res.status(400).json({
          message: "Use the location WhatsApp settings endpoint to change WhatsApp reporting configuration",
        });
      }

      const { name, transferWaGroupChatId, supplierPartnerPayableDeductionPerQty } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ message: "name is required" });
      }

      const updatePayload: Record<string, unknown> = { name: name.trim() };
      if (transferWaGroupChatId !== undefined) {
        updatePayload.transferWaGroupChatId = transferWaGroupChatId || null;
      }
      if (supplierPartnerPayableDeductionPerQty !== undefined) {
        const deductionVal = parseMoneyInput(supplierPartnerPayableDeductionPerQty)?.toNumber() ?? NaN;
        if (isNaN(deductionVal) || deductionVal < 0) {
          return res.status(400).json({ message: "supplierPartnerPayableDeductionPerQty must be >= 0" });
        }
        updatePayload.supplierPartnerPayableDeductionPerQty = deductionVal.toFixed(4);
      }

      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx.update(locations).set(updatePayload).where(eq(locations.id, locationId)).returning();

        const _locChanges: Record<string, { old?: unknown; new?: unknown }> = {};
        if (location.name !== written.name) _locChanges.name = { old: location.name, new: written.name };
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "update",
            tableName: "locations",
            recordId: written.id,
            recordIdentifier: written.name,
            changes: _locChanges,
          },
          tx
        );
        return written;
      });
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
