// Extracted from ./containerTrackingRoutes.ts
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { containers, containerTrackingImportRowSchema, type InsertContainer } from "@shared/schema";
import { eq, and, or, sql } from "drizzle-orm";
import { parseMoneyInput } from "../../lib/money";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export function registerContainerTrackingRoutesPart1(app: Express) {
  app.post("/api/containers/tracking/import", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      if (isExistingRecordReadOnlyRole(req.session.currentRole ?? req.user?.role)) {
        return res.status(403).json({ message: "This role cannot edit existing containers" });
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

          // Resolve local or actively linked parent physical container. Tracking
          // edits are written once to that shared row (no mirrored copies).
          const selectedCompanyId = req.session.currentCompanyId!;
          const candidates = await db
            .select()
            .from(containers)
            .where(
              and(
                eq(containers.containerNumber, containerNumber),
                or(
                  eq(containers.companyId, selectedCompanyId),
                  sql`EXISTS (
                    SELECT 1 FROM intercompany_trades trade
                    WHERE trade.physical_container_id = ${containers.id}
                      AND trade.source_company_id = ${containers.companyId}
                      AND trade.destination_company_id = ${selectedCompanyId}
                      AND trade.state = 'active'
                  )`
                )
              )
            );
          const owned = candidates.filter((item) => item.companyId === selectedCompanyId);
          const matches = owned.length ? owned : candidates;
          if (matches.length > 1) {
            errors.push(`Ambiguous container number: ${containerNumber}. Use a unique number.`);
            continue;
          }
          const container = matches[0];
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
            const n = parseMoneyInput(s.replace(/,/g, ""));
            return n === null ? null : String(n.toNumber());
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
    return res.status(410).json({
      message:
        "Automatic ETA/carrier tracking is disabled. Update ETA and tracking fields manually or by Excel import.",
    });
  });

  // Alias with a more descriptive path — same behavior as fetch-eta above.
  app.post("/api/containers/:id/refresh-eta", requireAuth, requireNonPOS, async (req, res) => {
    return res.status(410).json({
      message:
        "Automatic ETA/carrier tracking is disabled. Update ETA and tracking fields manually or by Excel import.",
    });
  });

  // POST /api/containers/refresh-etas — bulk JSONCargo ETA refresh, Admin/Developer/Owner only.
  app.post("/api/containers/refresh-etas", requireAuth, requireNonPOS, async (req, res) => {
    return res.status(410).json({
      message:
        "Automatic ETA/carrier tracking is disabled. Update ETA and tracking fields manually or by Excel import.",
    });
  });
}
