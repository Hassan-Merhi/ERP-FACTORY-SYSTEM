// Extracted from ./wasteDispatchBandwidthRoutes.ts
import type { Express, Request } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { resultRows } from "../../../lib/queryResult";

const DEFAULT_HISTORY_PAGE_SIZE = 10;

const MAX_HISTORY_PAGE_SIZE = 50;

export function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

// Reject malformed calendar dates rather than passing them through to PostgreSQL.
function validHistoryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

type FactorySession = Request["session"] & { factoryCompanyId?: number };

export function getCompanyId(req: Request): number | null {
  const session = req.session as FactorySession;
  const value = session.factoryCompanyId || session.currentCompanyId;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function registerWasteDispatchBandwidthRoutesPart1(app: Express) {
  // History is loaded incrementally. Counts and totals always cover the ENTIRE
  // filtered history, not just the current 10-row batch.
  app.get("/api/factory/waste-dispatch/history-summary", requireAuth, async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const startDate = String(req.query.startDate || "");
      const endDate = String(req.query.endDate || "");
      if ((startDate && !validHistoryDate(startDate)) || (endDate && !validHistoryDate(endDate))) {
        return res.status(400).json({ message: "Invalid history date. Use YYYY-MM-DD." });
      }
      if (startDate && endDate && startDate > endDate) {
        return res.status(400).json({ message: "From date must be on or before To date." });
      }

      const page = positiveInt(req.query.page, 1, Number.MAX_SAFE_INTEGER);
      const limit = positiveInt(req.query.limit, DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE);
      const offset = (page - 1) * limit;
      // Dispatch dates are SQL DATE values; inclusive comparisons avoid timezone shifts.
      const dateConditions = sql`
        ${startDate ? sql`AND dispatch_date >= ${startDate}::date` : sql``}
        ${endDate ? sql`AND dispatch_date <= ${endDate}::date` : sql``}
      `;

      const [pageRaw, totalsRaw] = await Promise.all([
        db.execute(sql`
          SELECT
            id,
            dispatch_number AS "dispatchNumber",
            dispatch_date AS "dispatchDate",
            notes,
            COALESCE(total_bales, 0)::int AS "totalBales",
            COALESCE(total_weight_kg, 0)::float AS "totalWeightKg",
            COALESCE(total_cost_written_off, 0)::float AS "totalCostWrittenOff",
            created_by AS "createdBy",
            created_at AS "createdAt"
          FROM factory_bale_waste_dispatches
          WHERE company_id = ${companyId}
            ${dateConditions}
          ORDER BY id DESC
          LIMIT ${limit}
          OFFSET ${offset}
        `),
        db.execute(sql`
          SELECT
            COUNT(*)::int AS "total",
            COALESCE(SUM(total_bales), 0)::float AS "bales",
            COALESCE(SUM(total_weight_kg), 0)::float AS "weightKg",
            COALESCE(SUM(total_cost_written_off), 0)::float AS "amount"
          FROM factory_bale_waste_dispatches
          WHERE company_id = ${companyId}
            ${dateConditions}
        `),
      ]);

      const rows = (Array.isArray(pageRaw) ? pageRaw : resultRows(pageRaw)) as Record<string, unknown>[];
      const aggregateRows = (Array.isArray(totalsRaw) ? totalsRaw : resultRows(totalsRaw)) as Record<string, unknown>[];
      const aggregate = aggregateRows[0];
      const total = Number(aggregate?.total || 0);

      res.json({
        items: rows.map((row) => ({
          ...row,
          id: Number(row.id),
          totalBales: Number(row.totalBales || 0),
          totalWeightKg: Number(row.totalWeightKg || 0),
          totalCostWrittenOff: Number(row.totalCostWrittenOff || 0),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
        totals: {
          bales: Number(aggregate?.bales || 0),
          weightKg: Number(aggregate?.weightKg || 0),
          amount: Number(aggregate?.amount || 0),
        },
      });
    } catch (error: unknown) {
      logger.error("Error fetching optimized waste dispatch history", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bale details are fetched only for the single dispatch the user expands or prints.
  app.get("/api/factory/waste-dispatch/history/:id/bales", requireAuth, async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const dispatchId = Number(req.params.id);
      if (!Number.isFinite(dispatchId) || dispatchId < 1) {
        return res.status(400).json({ message: "Invalid dispatch id" });
      }

      const dispatchRaw = await db.execute(sql`
        SELECT id
        FROM factory_bale_waste_dispatches
        WHERE id = ${dispatchId} AND company_id = ${companyId}
        LIMIT 1
      `);
      const dispatchRows = (Array.isArray(dispatchRaw) ? dispatchRaw : resultRows(dispatchRaw)) as Record<
        string,
        unknown
      >[];
      if (dispatchRows.length === 0) return res.status(404).json({ message: "Dispatch not found" });

      const raw = await db.execute(sql`
        SELECT
          id,
          reference_number AS "referenceNumber",
          product_name AS "productName",
          COALESCE(weight_kg, 0)::float AS "weightKg",
          COALESCE(total_cost, 0)::float AS "totalCost"
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND waste_dispatch_id = ${dispatchId}
        ORDER BY id ASC
      `);
      const rows = (Array.isArray(raw) ? raw : resultRows(raw)) as Record<string, unknown>[];
      res.json({
        bales: rows.map((row) => ({
          id: Number(row.id),
          referenceNumber: String(row.referenceNumber || ""),
          productName: String(row.productName || ""),
          weightKg: Number(row.weightKg || 0),
          totalCost: Number(row.totalCost || 0),
        })),
      });
    } catch (error: unknown) {
      logger.error("Error fetching waste dispatch history details", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
