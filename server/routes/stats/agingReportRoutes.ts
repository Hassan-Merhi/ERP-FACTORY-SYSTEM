/**
 * AR/AP aging and open items (accounting audit wave 17 A, phase 25).
 * See services/reports/agingReport.ts and services/accounting/allocations/
 * for the rules. Wave 18 C: factory suppliers, company business date.
 * Phase 25: employees, aging by due date on the allocation table, book
 * amounts, the control tie-out; the open items of one party, the FIFO run,
 * manual re-allocation (Admin/Owner, audited) and the phase 25 diagnostics.
 */
import type { Express, Request } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../db";
import { getErrorMessage, HttpError } from "../../lib/httpHandlers";
import { requireAuth, requireRole } from "../../auth";
import { AGING_KINDS, getAgingReport, type AgingKind } from "../../services/reports/agingReport";
import {
  lockAllOpenItemKindsTx,
  reallocateOpenItemsTx,
  syncOpenItemAllocationsTx,
  type AllocationActor,
} from "../../services/accounting/allocations/allocationService";
import {
  enableOpenItemAllocationTx,
  loadAllocationEnablement,
  previewOpenItemAllocationTx,
} from "../../services/accounting/allocations/allocationEnablement";
import { getOpenItemDiagnostics } from "../../services/accounting/allocations/openItemDiagnostics";
import { OPEN_ITEM_PARTY_KINDS } from "../../services/accounting/allocations/openItems";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KIND_MESSAGE = "kind must be customer, supplier, factorySupplier or employee";
const READ_ROLES = ["Admin", "Owner", "Manager"] as const;

function parseKind(value: unknown): AgingKind | null {
  return typeof value === "string" && AGING_KINDS.includes(value as AgingKind) ? (value as AgingKind) : null;
}

function actorOf(req: Request): AllocationActor {
  return {
    userId: String(req.user?.id ?? req.session.userId ?? "unknown"),
    username: String(req.user?.username ?? req.session.username ?? "unknown"),
  };
}

const reallocateBody = z.object({
  kind: z.enum(["customer", "supplier", "factorySupplier", "employee"]),
  partyId: z.number().int().positive(),
  release: z.array(z.number().int().positive()).max(500).default([]),
  allocate: z
    .array(
      z.object({
        invoiceVoucherId: z.number().int().positive().nullable(),
        paymentVoucherId: z.number().int().positive().nullable(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
      })
    )
    .max(500)
    .default([]),
  reason: z.string().trim().min(1).max(500),
});

function sendError(res: import("express").Response, error: unknown) {
  if (error instanceof HttpError) return res.status(error.statusCode).json({ message: error.message });
  return res.status(500).json({ message: getErrorMessage(error) });
}

export function registerAgingReportRoutes(app: Express) {
  app.get("/api/reports/aging", requireAuth, requireRole(...READ_ROLES), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const kind = parseKind(req.query.kind);
      if (!kind) return res.status(400).json({ message: KIND_MESSAGE });
      const asOfRaw = req.query.asOf;
      if (asOfRaw !== undefined && (typeof asOfRaw !== "string" || !ISO_DATE.test(asOfRaw))) {
        return res.status(400).json({ message: "asOf must be a single YYYY-MM-DD value" });
      }
      res.json(await getAgingReport(companyId, kind, asOfRaw ?? null));
    } catch (error: unknown) {
      sendError(res, error);
    }
  });

  // One party's open items, the allocation rows (live and released) and its aging row.
  app.get("/api/open-items", requireAuth, requireRole(...READ_ROLES), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const kind = parseKind(req.query.kind);
      if (!kind) return res.status(400).json({ message: KIND_MESSAGE });
      const partyId = Number.parseInt(String(req.query.partyId ?? ""), 10);
      if (!Number.isInteger(partyId) || partyId <= 0) return res.status(400).json({ message: "partyId is required" });
      const [report, rows] = await Promise.all([
        getAgingReport(companyId, kind, null),
        db.execute(
          sql`
            SELECT a.id, a.invoice_voucher_id AS "invoiceVoucherId", a.payment_voucher_id AS "paymentVoucherId",
                   a.amount::text AS amount, a.currency, a.method, a.reason, a.created_by AS "createdBy",
                   a.created_at AS "createdAt", a.released_at AS "releasedAt", a.released_by AS "releasedBy",
                   a.release_reason AS "releaseReason",
                   iv.voucher_number AS "invoiceVoucherNumber", pv.voucher_number AS "paymentVoucherNumber"
              FROM party_open_item_allocations a
              LEFT JOIN vouchers iv ON iv.id = a.invoice_voucher_id
              LEFT JOIN vouchers pv ON pv.id = a.payment_voucher_id
             WHERE a.company_id = ${companyId} AND a.party_kind = ${kind} AND a.party_id = ${partyId}
             ORDER BY a.id`
        ),
      ]);
      res.json({
        companyId,
        kind,
        partyId,
        aging: report.parties.find((party) => party.id === partyId) ?? null,
        referenceDate: report.referenceDate,
        allocations: rows.rows,
      });
    } catch (error: unknown) {
      sendError(res, error);
    }
  });

  // The plan of the reviewed first run (every kind) with its hash; read only.
  app.get("/api/open-items/allocate/preview", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await db.transaction((tx) => previewOpenItemAllocationTx(tx, companyId)));
    } catch (error: unknown) {
      sendError(res, error);
    }
  });

  // The automatic FIFO-by-due-date run for the current company (every kind, or one).
  // Integration review: until the company is enabled, only the Owner may run it,
  // with the reviewed preview's plan hash; that first run covers every kind and
  // enables the hourly run (allocationEnablement.ts). It posts no realized FX for
  // what it allocates (history tool: /api/accounting/realized-fx/history/plan).
  app.post("/api/open-items/allocate", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const requested = req.body?.kind;
      const actor = actorOf(req);
      const enabled = await loadAllocationEnablement(db, companyId);
      if (!enabled) {
        if (req.session.currentRole !== "Owner") {
          return res.status(403).json({
            code: "OPEN_ITEM_ALLOCATION_OWNER_FIRST_RUN",
            message: "The first allocation run of a company is the Owner's, after reviewing its preview.",
          });
        }
        if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
        const planHash = req.body?.planHash;
        if (typeof planHash !== "string" || !/^[0-9a-f]{64}$/.test(planHash)) {
          return res.status(400).json({
            code: "OPEN_ITEM_ALLOCATION_PLAN_HASH_REQUIRED",
            message: "The reviewed plan hash is required.",
          });
        }
        const outcome = await db.transaction(async (tx) => {
          await lockAllOpenItemKindsTx(tx, companyId);
          const preview = await previewOpenItemAllocationTx(tx, companyId);
          if (preview.enabled) return { conflict: "OPEN_ITEM_ALLOCATION_ALREADY_ENABLED" as const };
          if (preview.planHash !== planHash) return { conflict: "OPEN_ITEM_ALLOCATION_PLAN_CHANGED" as const };
          const enablement = await enableOpenItemAllocationTx(tx, { companyId, enabledBy: actor.userId, planHash });
          const out = [];
          for (const kind of OPEN_ITEM_PARTY_KINDS)
            out.push(await syncOpenItemAllocationsTx(tx, { companyId, kind, actor }));
          return { results: out, enabled: enablement };
        });
        if ("conflict" in outcome) {
          return res.status(409).json({
            code: outcome.conflict,
            message: "The allocation plan changed. Review the preview again.",
          });
        }
        return res.json(outcome);
      }
      const kinds = requested === undefined ? OPEN_ITEM_PARTY_KINDS : [parseKind(requested)];
      if (kinds.some((kind) => kind === null)) return res.status(400).json({ message: KIND_MESSAGE });
      const results = await db.transaction(async (tx) => {
        const out = [];
        for (const kind of kinds as AgingKind[])
          out.push(await syncOpenItemAllocationsTx(tx, { companyId, kind, actor }));
        return out;
      });
      res.json({ results, enabled });
    } catch (error: unknown) {
      sendError(res, error);
    }
  });

  // Manual re-allocation of one party's items (Admin/Owner; audited with the reason).
  app.post("/api/open-items/reallocate", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const parsed = reallocateBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid body" });
      const actor = actorOf(req);
      const result = await db.transaction((tx) => reallocateOpenItemsTx(tx, { companyId, ...parsed.data, actor }));
      res.json(result);
    } catch (error: unknown) {
      sendError(res, error);
    }
  });

  app.get("/api/open-items/diagnostics", requireAuth, requireRole(...READ_ROLES), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await getOpenItemDiagnostics(db, companyId));
    } catch (error: unknown) {
      sendError(res, error);
    }
  });
}
