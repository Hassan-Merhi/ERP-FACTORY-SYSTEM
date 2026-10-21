/** Phase 12 unified analytics & budgets API. Financial vouchers never mutated. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import { MonetaryFxError } from "../services/accounting/monetaryFxRates";
import { getErrorMessage } from "../lib/httpHandlers";
import {
  AnalyticError,
  listAnalyticCentersTx,
  upsertAnalyticCenterTx,
  recentAnalyticEntriesTx,
  addAnalyticAllocationTx,
  voidAnalyticAllocationTx,
  listAnalyticAllocationsTx,
  createAnalyticBudgetTx,
  changeAnalyticBudgetTx,
} from "../services/accounting/analyticAccountingService";
import { analyticBudgetActualTx, listAnalyticBudgetsTx } from "../services/accounting/analyticBudgetReport";
const moduleName = z.enum(["ERP", "FACTORY", "PROPERTIES", "SHARED"]);
const category = z.enum(["income", "cost_of_sales", "expense"]);
const id = z.coerce.number().int().positive();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const validMoney = z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const costCenter = z.object({
  code: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(180),
  module: moduleName,
  parentId: id.nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  note: z.string().max(1000).nullable().optional(),
});
const allocation = z.object({
  entryId: id,
  centerId: id,
  amountUsd: validMoney,
  note: z.string().max(1000).nullable().optional(),
  clientRequestKey: z.string().min(8).max(128),
});
const budget = z.object({
  centerId: id,
  monthStart: day,
  category,
  plannedUsd: validMoney,
  notes: z.string().max(1000).nullable().optional(),
});
const dateRange = z.object({ fromDate: day.optional(), asOfDate: day.optional() });
function company(req: Request) {
  const n = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(n) || n < 1) throw new AnalyticError("ANALYTIC_COMPANY_REQUIRED", "Select a company", 400);
  return n;
}
function actor(req: Request) {
  return {
    userId: String(req.session.userId ?? ""),
    username: String(req.session.username ?? req.session.userId ?? "unknown"),
  };
}
function failure(res: Response, error: unknown) {
  if (error instanceof z.ZodError)
    return res.status(400).json({
      code: "ANALYTIC_INVALID_REQUEST",
      message: error.issues.map((e) => e.message).join("; "),
    });
  if (error instanceof AnalyticError)
    return res.status(error.status).json({
      code: error.code,
      message: error.message,
    });
  if (error instanceof MonetaryFxError)
    return res.status(error.status).json({
      code: error.code,
      message: error.message,
    });
  // Durable unique constraints arbitrate concurrent inserts that both passed
  // the frontend validation (same cost-center code, budget month or request key).
  const sqlState = (error as { code?: string; constraint?: string })?.code;
  if (sqlState === "23505")
    return res.status(409).json({
      code: "ANALYTIC_CONFLICT",
      message: "A cost center, active monthly budget or allocation request with this identity already exists",
    });
  if (sqlState === "23503" || sqlState === "23514")
    return res.status(400).json({
      code: "ANALYTIC_SOURCE_INVALID",
      message: "The cost center, parent or original voucher entry is not valid for the selected company",
    });
  const msg = getErrorMessage(error);
  const bad =
    msg === "ANALYTIC_PERIOD_INVALID" ||
    msg === "ANALYTIC_FUTURE_DATE" ||
    msg === "ANALYTIC_HIERARCHY_CYCLE" ||
    msg === "ANALYTIC_PARENT_CROSS_COMPANY";
  return res.status(bad ? 400 : 500).json({
    code: bad ? "ANALYTIC_INVALID_REQUEST" : "ANALYTIC_OPERATION_FAILED",
    message: bad ? msg : "Could not complete analytic accounting request",
  });
}
export function registerAnalyticAccountingRoutes(app: Express) {
  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  app.get("/api/accounting/analytics/centers", ...gate, async (req, res) => {
    try {
      const result = await db.transaction((tx) => listAnalyticCentersTx(tx, company(req)));
      res.setHeader("Cache-Control", "no-store");
      return res.json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/analytics/centers", ...gate, async (req, res) => {
    try {
      const body = costCenter.parse(req.body),
        c = company(req);
      const result = await db.transaction((tx) =>
        upsertAnalyticCenterTx(tx, {
          ...body,
          companyId: c,
          actor: actor(req),
        })
      );
      return res.status(201).json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.put("/api/accounting/analytics/centers/:id", ...gate, async (req, res) => {
    try {
      const body = costCenter.parse(req.body),
        c = company(req),
        centerId = id.parse(req.params.id);
      return res.json(
        await db.transaction((tx) =>
          upsertAnalyticCenterTx(tx, {
            ...body,
            id: centerId,
            companyId: c,
            actor: actor(req),
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/analytics/entries", ...gate, async (req, res) => {
    try {
      const { search, limit } = z
          .object({
            search: z.string().max(100).optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
          })
          .parse(req.query),
        c = company(req);
      res.setHeader("Cache-Control", "no-store");
      return res.json(
        await db.transaction((tx) =>
          recentAnalyticEntriesTx(tx, {
            companyId: c,
            search,
            limit,
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/analytics/allocations", ...gate, async (req, res) => {
    try {
      const body = z.object({ centerId: id.optional() }).parse(req.query);
      const c = company(req);
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        allocations: await db.transaction((tx) =>
          listAnalyticAllocationsTx(tx, {
            companyId: c,
            centerId: body.centerId,
          })
        ),
      });
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/analytics/allocations", ...gate, async (req, res) => {
    try {
      const payload = allocation.parse(req.body),
        c = company(req);
      const result = await db.transaction((tx) =>
        addAnalyticAllocationTx(tx, {
          ...payload,
          companyId: c,
          actor: actor(req),
        })
      );
      return res.status(result.replayed ? 200 : 201).json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/analytics/allocations/:id/void", ...gate, async (req, res) => {
    try {
      const c = company(req),
        allocationId = id.parse(req.params.id);
      const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
      return res.json(
        await db.transaction((tx) =>
          voidAnalyticAllocationTx(tx, {
            companyId: c,
            allocationId,
            reason: body.reason,
            actor: actor(req),
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/analytics/budgets", ...gate, async (req, res) => {
    try {
      const { fromDate, asOfDate, includeArchived } = z
        .object({
          ...dateRange.shape,
          includeArchived: z.enum(["true", "false"]).optional(),
        })
        .parse(req.query);
      const c = company(req),
        today = await companyBusinessDate(c);
      res.setHeader("Cache-Control", "no-store");
      return res.json(
        await db.transaction((tx) =>
          listAnalyticBudgetsTx(tx, {
            companyId: c,
            fromDate: fromDate ?? today.slice(0, 4) + "-01-01",
            asOfDate: asOfDate ?? today,
            includeArchived: includeArchived === "true",
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/analytics/budgets", ...gate, async (req, res) => {
    try {
      const payload = budget.parse(req.body),
        c = company(req);
      const result = await db.transaction((tx) =>
        createAnalyticBudgetTx(tx, {
          ...payload,
          companyId: c,
          actor: actor(req),
        })
      );
      return res.status(201).json(result);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/analytics/budgets/:id/approve", ...gate, async (req, res) => {
    try {
      const c = company(req),
        budgetId = id.parse(req.params.id);
      return res.json(
        await db.transaction((tx) =>
          changeAnalyticBudgetTx(tx, {
            companyId: c,
            budgetId,
            operation: "APPROVE",
            actor: actor(req),
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/analytics/budgets/:id/archive", ...gate, async (req, res) => {
    try {
      const c = company(req),
        budgetId = id.parse(req.params.id);
      const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
      return res.json(
        await db.transaction((tx) =>
          changeAnalyticBudgetTx(tx, {
            companyId: c,
            budgetId,
            operation: "ARCHIVE",
            reason: body.reason,
            actor: actor(req),
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/analytics/report", ...gate, async (req, res) => {
    try {
      const b = dateRange.parse(req.query),
        c = company(req);
      const today = await companyBusinessDate(c);
      const asOfDate = b.asOfDate ?? today;
      const fromDate = b.fromDate ?? asOfDate.slice(0, 4) + "-01-01";
      res.setHeader("Cache-Control", "no-store");
      return res.json(
        await db.transaction((tx) =>
          analyticBudgetActualTx(tx, {
            companyId: c,
            fromDate,
            asOfDate,
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
}
