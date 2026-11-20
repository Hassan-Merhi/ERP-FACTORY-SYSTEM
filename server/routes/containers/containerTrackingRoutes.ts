import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { logger } from "../../lib/logger";
import { containers, updateContainerTrackingSchema, userCompanyRoles, type InsertContainer } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { getEtaTrackingSummary } from "../../services/jsonCargoTrackingService";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";
import { registerContainerTrackingRoutesPart1 } from "./registerContainerTrackingRoutesPart1";
import { emptyQuery, idParams, validateRequest, validatedInput, type RequestSchemas } from "../../lib/validateRequest";

const updateTrackingInput = {
  params: idParams,
  query: emptyQuery,
  body: updateContainerTrackingSchema.strict(),
} satisfies RequestSchemas;

export function registerContainerTrackingRoutes(app: Express) {
  app.patch(
    "/api/containers/:id/tracking",
    requireAuth,
    requireNonPOS,
    validateRequest(updateTrackingInput),
    async (req, res) => {
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
        if (isExistingRecordReadOnlyRole(req.session.currentRole ?? req.user?.role)) {
          return res.status(403).json({ message: "This role cannot edit existing containers" });
        }
        const { params, body } = validatedInput(req, updateTrackingInput);
        const id = params.id;

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
        } = body;

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
            // One physical record is shared by active intercompany trades. A user
            // selected into the destination company can edit the same tracking
            // fields; the parent immediately sees the update on that record.
            const [linkedDestination] = await db
              .execute(
                sql`
            SELECT 1 FROM intercompany_trades trade
            WHERE trade.physical_container_id = ${id}
              AND trade.destination_company_id = ${req.session.currentCompanyId!}
              AND trade.source_company_id = ${existing.companyId}
              AND trade.state = 'active'
            LIMIT 1
          `
              )
              .then((result) => result.rows);
            if (!linkedDestination) {
              return res.status(404).json({ message: "Container not found" });
            }
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
    }
  );

  // Update container number

  registerContainerTrackingRoutesPart1(app);

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
