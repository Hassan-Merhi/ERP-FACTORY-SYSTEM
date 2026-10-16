/** Tracking edits for SP source containers, never financial lifecycle edits. */
import type { Express } from "express";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { firstRow } from "../../lib/queryResult";
import { resolveGitCompanyScope } from "../../lib/gitHelpers";
import { ensureSpGitTracking, SP_GIT_STATUSES, SP_GIT_FIELDS } from "../../lib/spGitTracking";
import { updateContainerTrackingSchema } from "@shared/schema";

const names: Record<(typeof SP_GIT_FIELDS)[number], string> = {
  shopName: "shop_name",
  eta: "eta",
  transporter: "transporter",
  transportFee: "transport_fee",
  numberPlate: "number_plate",
  trackingLocation: "tracking_location",
  borderDate: "border_date",
  agent: "agent",
  dutyFee: "duty_fee",
  docReceived: "doc_received",
  trackingDescription: "tracking_description",
  blDocs: "bl_docs",
  docsSentDate: "docs_sent_date",
  trackingLink: "tracking_link",
  freightStatus: "freight_status",
};
const textFields = new Set<string>([
  "shopName", "transporter", "numberPlate", "trackingLocation", "agent", "trackingDescription", "blDocs", "trackingLink", "freightStatus",
]);
const dateFields = new Set<string>(["eta", "borderDate", "docsSentDate"]);
const moneyFields = new Set<string>(["transportFee", "dutyFee"]);

export function registerSpGitTrackingRoutes(app: Express): void {
  app.patch("/api/git/sp-containers/:id/tracking", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid SP container ID" });
    try {
      const parsed = updateContainerTrackingSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid tracking data", errors: parsed.error.issues });
      // GIT status is distinct from SP financial lifecycle. No caller can
      // mark a container offloaded or change its invoice/ledger through GIT.
      if (parsed.data.offloadDate !== undefined || parsed.data.etaSource !== undefined) {
        return res.status(400).json({ message: "Offload and automated ETA fields cannot be changed through SP GIT tracking" });
      }
      const status = parsed.data.status;
      if (status !== undefined && status !== null && !SP_GIT_STATUSES.some((allowed) => allowed === status)) {
        return res.status(400).json({ message: "Only active logistics statuses may be set here; use Offload to receive stock" });
      }
      await ensureSpGitTracking();
      const existing = firstRow<{ company_id: number; status: string }>(await db.execute(sql`
        SELECT company_id, status FROM sp_containers WHERE id = ${id} LIMIT 1
      `));
      if (!existing) return res.status(404).json({ message: "Supplier Partner container not found" });
      if (existing.status !== "open") return res.status(409).json({ message: "Only open containers can have logistics fields edited" });
      const userId = String((req.user as { id: unknown }).id);
      const role = String(req.session?.currentRole ?? (req.user as { role: unknown }).role ?? "");
      const scope = await resolveGitCompanyScope(userId, role, {
        companyId: String(existing.company_id),
      }, req.session?.currentCompanyId);
      if ("error" in scope) return res.status(scope.status).json({ message: scope.error, code: scope.code });

      const patch = parsed.data;
      const assignments = SP_GIT_FIELDS.flatMap((field) => {
        const value = patch[field];
        if (value === undefined) return [];
        let normalized: string | boolean | null = value === null || value === "" ? null : String(value);
        if (field === "docReceived") normalized = value === null ? null : Boolean(value);
        if (dateFields.has(field) && normalized !== null && typeof normalized === "string" &&
            !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
          throw new Error("Invalid date");
        }
        if (moneyFields.has(field) && normalized !== null) {
          const amount = Number(normalized);
          if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) throw new Error("Invalid logistics charge");
          normalized = amount.toFixed(4);
        }
        if (textFields.has(field) && normalized !== null && String(normalized).length > 2000) {
          throw new Error("Logistics value is too long");
        }
        return [sql`${sql.raw(names[field])} = ${normalized}`];
      });
      if (status !== undefined) assignments.push(sql`status = ${status}`);
      if (assignments.length === 0) return res.json({ ok: true });
      await db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO sp_container_git_tracking (container_id, company_id)
          VALUES (${id}, ${existing.company_id}) ON CONFLICT (container_id) DO NOTHING`);
        await tx.execute(sql`UPDATE sp_container_git_tracking SET
          ${sql.join(assignments, sql`, `)}, updated_at = now()
          WHERE container_id = ${id} AND company_id = ${existing.company_id}`);
      });
      return res.json({ ok: true, containerId: id });
    } catch (error) {
      logger.error("SP GIT tracking update failed", { containerId: id, error });
      return res.status(500).json({ message: "Unable to update Supplier Partner tracking" });
    }
  });
}
