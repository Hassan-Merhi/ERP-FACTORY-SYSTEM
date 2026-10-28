import { describe, expect, it } from "vitest";
import {
  PRESSING_REPORT_COLUMNS, PRESSING_DEFAULT_COLUMNS,
  pressingReportFiltersSchema, pressingSavedViewSchema,
} from "../shared/pressingReportContracts";
import fs from "node:fs";

const server = fs.readFileSync("server/routes/factory/factoryPressingReportRoutes.ts", "utf8");
const client = fs.readFileSync("client/src/pages/factory/pressing-scanner/pressingReportClient.ts", "utf8");
const page = fs.readFileSync("client/src/pages/factory/PressingHistoryReport.tsx", "utf8");
const parent = fs.readFileSync("client/src/pages/factory/PressingMachineManagement.tsx", "utf8");
const registration = fs.readFileSync("server/routes/factoryRoutes.ts", "utf8");
const indexSql = fs.readFileSync("migrations/20261027_002_factory_pressing_history_report_indexes.sql", "utf8");
const stage = fs.readFileSync("server/startup-schema/038-factory-pressing-history-report.ts", "utf8");

describe("pressing machine Phase 6 reporting contracts", () => {
  it("rejects invalid dates, excessive pagination and unknown filter fields", () => {
    expect(pressingReportFiltersSchema.safeParse({ from: "2026-02-30" }).success).toBe(false);
    expect(pressingReportFiltersSchema.safeParse({ from: "2026-10-27" }).success).toBe(true);
    expect(pressingReportFiltersSchema.safeParse({ limit: "251" }).success).toBe(false);
    expect(pressingReportFiltersSchema.safeParse({ page: "0" }).success).toBe(false);
    expect(pressingReportFiltersSchema.safeParse({ companyId: 999 }).success).toBe(false);
    expect(pressingReportFiltersSchema.safeParse({ status: "invalid" }).success).toBe(false);
    expect(pressingReportFiltersSchema.safeParse({ weightKg: "40" }).success).toBe(true);
    expect(pressingReportFiltersSchema.safeParse({ weightKg: "45.5" }).success).toBe(true);
    expect(pressingReportFiltersSchema.safeParse({ weightKg: "0" }).success).toBe(false);
    expect(pressingReportFiltersSchema.safeParse({ weightKg: "-1" }).success).toBe(false);
  });
  it("accepts saved view filters and strict column names", () => {
    const view = {
      name: "My Daily Scan", mode: "detailed", isDefault: true,
      filters: { from: "2026-10-27", to: "2026-10-27", status: "active" },
      visibleColumns: [...PRESSING_DEFAULT_COLUMNS],
    };
    expect(pressingSavedViewSchema.safeParse(view).success).toBe(true);
    expect(pressingSavedViewSchema.safeParse({ ...view, visibleColumns: ["random_sql_column"] }).success).toBe(false);
    expect(PRESSING_REPORT_COLUMNS).toContain("secondsSincePrevious");
    expect(PRESSING_REPORT_COLUMNS).toContain("bales");
  });
  it("registers report endpoints after factory authorization boundary", () => {
    expect(registration).toContain("registerFactoryPressingReportRoutes(app)");
    expect(registration.indexOf('app.use("/api/factory", enforceFactoryBackendAccess)'))
      .toBeLessThan(registration.indexOf("registerFactoryPressingReportRoutes(app)"));
    expect(server).toContain('app.get("/api/factory/pressing-machines/report", requireAuth');
    expect(server).toContain('app.get("/api/factory/pressing-machines/report/options", requireAuth');
    expect(server).toContain('app.get("/api/factory/pressing-machines/report/views", requireAuth');
    expect(server).toContain('app.post("/api/factory/pressing-machines/report/views", requireAuth');
  });
  it("enforces current company and operator-only row access on all filtered history", () => {
    expect(server).toContain("getActiveCompanyPermissionContext(req)");
    expect(server).toContain('const where: string[] = ["c.company_id = $1"]');
    expect(server).toContain("if (!ctx.supervisor)");
    expect(server).toContain("Operators can view only their own records");
    expect(server).toContain('push("c.user_id = ?", ctx.userId)');
    expect(server).toContain('eq(factoryPressingSavedViews.userId, ctx.userId)');
    expect(server).toContain('eq(factoryPressingSavedViews.companyId, ctx.companyId)');
    expect(server).toContain("MANAGER_ROLES.has(ctx.role) && !ctx.posViewOnly");
  });
  it("uses accepted server confirmations with no inventory or queue changes", () => {
    expect(server).toContain("FROM factory_pressing_confirmations c");
    expect(server).toContain('c.voided_at IS NULL');
    expect(server).toContain("COUNT(*) FILTER (WHERE c.voided_at IS NULL)");
    expect(server).toContain("SUM(c.weight_kg) FILTER (WHERE c.voided_at IS NULL)");
    expect(server).toContain("COUNT(*) FILTER (WHERE c.voided_at IS NOT NULL)");
    expect(server).not.toContain("factory_bales SET");
    expect(server).not.toContain("adjustInventory");
    expect(server).not.toContain("writeDaybookEntry");
  });
  it("uses filtered date, shift, article, search and machine with stable page anchor", () => {
    expect(server).toContain('c.confirmed_at >= (?::date::timestamp AT TIME ZONE');
    expect(server).toContain('c.confirmed_at < ((?::date + 1)::timestamp AT TIME ZONE');
    expect(server).toContain('const PRESSING_LOCAL_DATE_SQL');
    expect(server).toContain("GROUP BY ' + PRESSING_LOCAL_DATE_SQL");
    expect(server).toContain('push("c.machine_id = ?", filters.machineId)');
    expect(server).toContain('push("c.weight_kg = ?::numeric", filters.weightKg)');
    expect(server).toContain('push("c.shift_id = ?", filters.shiftId)');
    expect(server).toContain("filters.articleCode");
    expect(server).toContain("filters.search");
    expect(server).toContain("const asOf = filters.asOf ?? new Date().toISOString()");
    expect(server).toContain('COUNT(*)::integer AS "bales"');
    expect(server).toContain('c.product_name AS "productName"');
    expect(server).toContain('c.article_code,c.product_name,(c.voided_at IS NOT NULL)');
    expect(server).toContain('const pageArgs = [...args, filters.limit, (filters.page - 1) * filters.limit]');
  });
  it("calculates previous-machine intervals outside the visible filter and indexes lookup", () => {
    expect(server).toContain("p.machine_id = c.machine_id");
    expect(server).toContain("p.voided_at IS NULL");
    expect(server).toContain('AS "secondsSincePrevious"');
    expect(indexSql).toContain("factory_pressing_confirmations_machine_time_idx");
    expect(indexSql).toContain("confirmed_at DESC, id DESC");
    expect(stage).toContain("factory_pressing_confirmations_machine_time_idx");
  });
  it("has a company-scoped history UI, saved filters, paginated rows and export", () => {
    expect(parent).toContain("<PressingHistoryReport");
    expect(parent).toContain('key={companyId + ":" + userId}');
    expect(page).toContain("This Month");
    expect(page).toContain("All Time");
    expect(page).toContain('aria-label="Pressing user filter"');
    expect(page).toContain("All users");
    expect(page).toContain("Scanned Bales");
    expect(page).toContain('<th className="p-3">Bale name</th>');
    expect(page).toContain('{row.productName || "—"}');
    expect(page).toContain('"operatorName", "productName", "bales"');
    expect(page).toContain('useState(false)');
    expect(page).toContain('aria-label="Pressing KG filter"');
    expect(page).toContain('pressing-kpi-');
    expect(page).toContain('mode: "condensed"');
    expect(page).toContain('const allWorkerBales = workers.reduce');
    expect(client).toContain('item.isPressingWorker === true && item.username?.trim().toUpperCase() === slot');
    expect(client).toContain('operator?.displayName?.trim()');
    expect(page).toContain('pressingKpiWorkers(operators, byOperator)');
    expect(page).toContain('data-testid={"pressing-kpi-display-name-" + worker.slot.toLowerCase()}');
    expect(server).toContain('AS "displayName"');
    expect(server).toContain('overview');
    expect(server).toContain('byOperatorSqlFor');
    expect(page).toContain("Export Excel");
    expect(page).toContain("queryClient.invalidateQueries");
    expect(client).toContain("XLSX.writeFile");
    expect(client).toContain("first.total > PRESSING_EXPORT_LIMIT");
    expect(client).toContain("asOf: first.asOf");
  });
});
