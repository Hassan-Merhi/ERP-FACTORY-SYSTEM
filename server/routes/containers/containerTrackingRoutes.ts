import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { logger } from "../../lib/logger";
import {
  containers,
  containerTrackingImportRowSchema,
  updateContainerTrackingSchema,
  userCompanyRoles,
  type InsertContainer,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import {
  refreshContainerEta,
  refreshMultipleContainerEtas,
  getEtaTrackingSummary,
} from "../../services/jsonCargoTrackingService";

const JSONCARGO_ADMIN_ROLES = ["Admin", "Developer", "Owner"];

export function registerContainerTrackingRoutes(app: Express) {
  app.patch("/api/containers/:id/tracking", requireAuth, requireNonPOS, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("container tracking update started", {
        module: "containers",
        action: "updateTracking",
        userId: _uid,
        companyId: _cid,
      });
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid container ID" });
      }

      // Validate request body with Zod schema
      const parseResult = updateContainerTrackingSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          message: "Invalid tracking data",
          errors: parseResult.error.issues,
        });
      }

      const {
        shopName,
        eta,
        etaSource,
        transporter,
        transportFee,
        numberPlate,
        trackingLocation,
        borderDate,
        offloadDate,
        agent,
        dutyFee,
        docReceived,
        trackingDescription,
        docsSentDate,
        freightStatus,
        trackingLink,
        status,
        blDocs,
      } = parseResult.data;

      const updateData: Partial<InsertContainer> = {};
      if (shopName !== undefined) updateData.shopName = shopName;
      if (eta !== undefined) updateData.eta = eta || null;
      if (etaSource !== undefined) updateData.etaSource = etaSource;
      if (transporter !== undefined) updateData.transporter = transporter;
      if (transportFee !== undefined) updateData.transportFee = transportFee || null;
      if (numberPlate !== undefined) updateData.numberPlate = numberPlate;
      if (trackingLocation !== undefined) updateData.trackingLocation = trackingLocation;
      if (borderDate !== undefined) updateData.borderDate = borderDate || null;
      if (offloadDate !== undefined) {
        updateData.offloadDate = offloadDate || null;
        // When an offload date is recorded, always force status to OFFLOADED
        // regardless of the container's previous location or status.
        if (offloadDate) updateData.status = "OFFLOADED";
      }
      if (agent !== undefined) updateData.agent = agent;
      if (dutyFee !== undefined) updateData.dutyFee = dutyFee || null;
      if (docReceived !== undefined) updateData.docReceived = docReceived;
      if (trackingDescription !== undefined) updateData.trackingDescription = trackingDescription;
      if (docsSentDate !== undefined) updateData.docsSentDate = docsSentDate || null;
      if (freightStatus !== undefined) updateData.freightStatus = freightStatus || null;
      if (trackingLink !== undefined) updateData.trackingLink = trackingLink || null;
      // `containers.status` is NOT NULL, but the request schema allows an explicit
      // null; writing it produced a NOT NULL violation rather than a clear result,
      // so an explicit null leaves the column unchanged.
      if (status != null) updateData.status = status;
      if (blDocs !== undefined) updateData.blDocs = blDocs || null;

      // Fetch the container first to resolve its company, then verify the user
      // has access. Admin/Owner users may manage containers from any company
      // they have a role in (cross-company OTW view), not just their current
      // session company.
      const [existing] = await db
        .select({ id: containers.id, companyId: containers.companyId })
        .from(containers)
        .where(eq(containers.id, id))
        .limit(1);

      if (!existing) {
        return res.status(404).json({ message: "Container not found" });
      }

      // Allow if same company, otherwise require an explicit role assignment in
      // the container's company (covers Admin/Owner cross-company OTW edits).
      if (existing.companyId !== req.session.currentCompanyId) {
        const [roleRow] = await db
          .select({ id: userCompanyRoles.id })
          .from(userCompanyRoles)
          .where(
            and(
              eq(userCompanyRoles.userId, req.session.userId as string),
              eq(userCompanyRoles.companyId, existing.companyId)
            )
          )
          .limit(1);

        if (!roleRow) {
          return res.status(404).json({ message: "Container not found" });
        }
      }

      await db.update(containers).set(updateData).where(eq(containers.id, id));

      const [updated] = await db.select().from(containers).where(eq(containers.id, id)).limit(1);

      if (!updated) {
        return res.status(404).json({ message: "Container not found" });
      }

      logger.info("container tracking update succeeded", {
        module: "containers",
        action: "updateTracking",
        userId: _uid,
        companyId: _cid,
        containerId: id,
        durationMs: Date.now() - _t,
      });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("container tracking update failed", {
        module: "containers",
        action: "updateTracking",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Update container number

  app.post("/api/containers/tracking/import", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No data provided" });
      }

      let updated = 0;
      let notFound = 0;
      const errors: string[] = [];

      for (const row of rows) {
        try {
          const parseResult = containerTrackingImportRowSchema.safeParse(row);
          if (!parseResult.success) {
            errors.push(`Invalid row data for ${row.containerNumber || "unknown"}`);
            continue;
          }

          const data = parseResult.data;
          const containerNumber = data.containerNumber?.trim();
          if (!containerNumber) {
            errors.push("Missing container number in row");
            continue;
          }

          // Find container by number
          const [container] = await db
            .select()
            .from(containers)
            .where(
              and(
                eq(containers.containerNumber, containerNumber),
                eq(containers.companyId, req.session.currentCompanyId!)
              )
            )
            .limit(1);

          if (!container) {
            notFound++;
            errors.push(`Container not found: ${containerNumber}`);
            continue;
          }

          // Normalise any date string to YYYY-MM-DD; return null for invalid values
          const normDate = (v: unknown): string | null => {
            if (!v) return null;
            if (v instanceof Date) {
              if (isNaN(v.getTime())) return null;
              const y = v.getFullYear();
              const m = String(v.getMonth() + 1).padStart(2, "0");
              const d = String(v.getDate()).padStart(2, "0");
              return `${y}-${m}-${d}`;
            }
            const s = String(v).trim();
            if (!s || s === "[object Object]") return null;
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            // MM/DD/YY or MM/DD/YYYY
            const sl = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
            if (sl) {
              const [, mo, dy, yr] = sl;
              const fullYr = yr.length === 2 ? (parseInt(yr) >= 50 ? `19${yr}` : `20${yr}`) : yr;
              return `${fullYr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}`;
            }
            const parsed = new Date(s);
            if (!isNaN(parsed.getTime())) {
              const y = parsed.getFullYear();
              const m = String(parsed.getMonth() + 1).padStart(2, "0");
              const d = String(parsed.getDate()).padStart(2, "0");
              return `${y}-${m}-${d}`;
            }
            return null;
          };

          // Sanitise numeric cell values — reject "[object Object]" strings that can come from ExcelJS
          const normNum = (v: unknown): string | null => {
            if (v === null || v === undefined || v === "") return null;
            const s = String(v).trim();
            if (!s || s === "[object Object]") return null;
            const n = parseFloat(s.replace(/,/g, ""));
            return isNaN(n) ? null : String(n);
          };

          // Build update object
          const updateData: Partial<InsertContainer> = {};
          if (data.shopName && String(data.shopName) !== "[object Object]") updateData.shopName = String(data.shopName);
          const etaDate = normDate(data.eta);
          if (etaDate) updateData.eta = etaDate;
          if (data.transporter && String(data.transporter) !== "[object Object]")
            updateData.transporter = String(data.transporter);
          const tFee = normNum(data.transportFee);
          if (tFee !== null) updateData.transportFee = tFee;
          if (data.numberPlate && String(data.numberPlate) !== "[object Object]")
            updateData.numberPlate = String(data.numberPlate);
          if (data.trackingLocation && String(data.trackingLocation) !== "[object Object]")
            updateData.trackingLocation = String(data.trackingLocation);
          const borderDateVal = normDate(data.borderDate);
          if (borderDateVal) updateData.borderDate = borderDateVal;
          const offloadDateVal = normDate(data.offloadDate);
          if (offloadDateVal) updateData.offloadDate = offloadDateVal;
          if (data.agent && String(data.agent) !== "[object Object]") updateData.agent = String(data.agent);
          const dFee = normNum(data.dutyFee);
          if (dFee !== null) updateData.dutyFee = dFee;
          if (data.docReceived !== undefined) {
            updateData.docReceived =
              data.docReceived === true ||
              data.docReceived === "Yes" ||
              data.docReceived === "yes" ||
              data.docReceived === "YES" ||
              data.docReceived === "TRUE" ||
              data.docReceived === "true";
          }
          if (data.trackingDescription && String(data.trackingDescription) !== "[object Object]")
            updateData.trackingDescription = String(data.trackingDescription);

          if (Object.keys(updateData).length > 0) {
            await db.update(containers).set(updateData).where(eq(containers.id, container.id));
            updated++;
          }
        } catch (rowError: unknown) {
          errors.push(`Error processing ${row.containerNumber || "unknown"}: ${getErrorMessage(rowError)}`);
        }
      }

      res.json({
        success: true,
        updated,
        notFound,
        total: rows.length,
        errors: errors.slice(0, 10), // Return first 10 errors
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Fetch container ETA via JSONCargo (Maersk / Hapag-Lloyd / MSC / CMA CGM only).
  // Any authenticated non-POS user in the container's own company may trigger this,
  // matching the permission level of the manual tracking-fields PATCH above.
  app.post("/api/containers/:id/fetch-eta", requireAuth, requireNonPOS, async (req, res) => {
    if (!req.session.currentCompanyId) {
      return res.status(400).json({ message: "No company selected" });
    }
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ message: "Invalid container ID" });
    }

    try {
      const result = await refreshContainerEta(id, {
        forceRefresh: req.body?.forceRefresh === true,
        companyId: req.session.currentCompanyId,
      });
      res.json(result);
    } catch (error: unknown) {
      if (getErrorMessage(error) === "Container not found") {
        return res.status(404).json({ message: "Container not found" });
      }
      res.status(500).json({ message: getErrorMessage(error) ?? "Failed to refresh ETA" });
    }
  });

  // Alias with a more descriptive path — same behavior as fetch-eta above.
  app.post("/api/containers/:id/refresh-eta", requireAuth, requireNonPOS, async (req, res) => {
    if (!req.session.currentCompanyId) {
      return res.status(400).json({ message: "No company selected" });
    }
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ message: "Invalid container ID" });
    }

    try {
      const result = await refreshContainerEta(id, {
        forceRefresh: req.body?.forceRefresh === true,
        companyId: req.session.currentCompanyId,
      });
      res.json(result);
    } catch (error: unknown) {
      if (getErrorMessage(error) === "Container not found") {
        return res.status(404).json({ message: "Container not found" });
      }
      res.status(500).json({ message: getErrorMessage(error) ?? "Failed to refresh ETA" });
    }
  });

  // POST /api/containers/refresh-etas — bulk JSONCargo ETA refresh, Admin/Developer/Owner only.
  app.post("/api/containers/refresh-etas", requireAuth, requireNonPOS, async (req, res) => {
    const role = req.user?.role;
    if (!role || !JSONCARGO_ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    if (!req.session.currentCompanyId) {
      return res.status(400).json({ message: "No company selected" });
    }

    try {
      const containerIds = Array.isArray(req.body?.containerIds)
        ? req.body.containerIds.filter((n: unknown): n is number => Number.isInteger(n))
        : undefined;

      const summary = await refreshMultipleContainerEtas(containerIds, {
        forceRefresh: req.body?.forceRefresh === true,
        companyId: req.session.currentCompanyId,
      });

      const message =
        summary.total === 0
          ? "No containers were eligible for a JSONCargo ETA refresh (unsupported carrier, inactive, or none tracked)."
          : `Checked ${summary.total} container(s): ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
            `${summary.noEta} with no ETA yet, ${summary.notFound} not found, ${summary.skippedRecent} skipped (checked recently), ` +
            `${summary.errors} failed.`;

      res.json({ ...summary, message });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) ?? "Bulk ETA refresh failed" });
    }
  });

  // GET /api/containers/eta-tracking-summary — dashboard summary, no secrets/raw data.
  app.get("/api/containers/eta-tracking-summary", requireAuth, requireNonPOS, async (req, res) => {
    if (!req.session.currentCompanyId) {
      return res.status(400).json({ message: "No company selected" });
    }
    try {
      const summary = await getEtaTrackingSummary(req.session.currentCompanyId);
      res.json(summary);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) ?? "Failed to load ETA tracking summary" });
    }
  });

  // Get POs for a container (for viewing details from dashboard)
}
