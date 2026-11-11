import { describe, expect, it } from "vitest";
import {
  PRESSING_REPORT_COLUMNS,
  PRESSING_DEFAULT_COLUMNS,
  pressingReportFiltersSchema,
  pressingSavedViewSchema,
} from "../shared/pressingReportContracts";
import fs from "node:fs";
import { codeShape, fragmentFor, shaped } from "./helpers/codeShape";

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
    expect(
      pressingReportFiltersSchema.safeParse({
        from: "2026-10-28",
        fromTime: "08:05",
        to: "2026-10-28",
        toTime: "17:45",
      }).success
    ).toBe(true);
    expect(pressingReportFiltersSchema.safeParse({ fromTime: "24:00" }).success).toBe(false);
    expect(pressingReportFiltersSchema.safeParse({ toTime: "12:60" }).success).toBe(false);
    expect(pressingReportFiltersSchema.safeParse({ fromTime: "9:05" }).success).toBe(false);
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
      name: "My Daily Scan",
      mode: "detailed",
      isDefault: true,
      filters: { from: "2026-10-27", to: "2026-10-27", status: "active" },
      visibleColumns: [...PRESSING_DEFAULT_COLUMNS],
    };
    expect(pressingSavedViewSchema.safeParse(view).success).toBe(true);
    expect(
      pressingSavedViewSchema.safeParse({ ...view, filters: { ...view.filters, fromTime: "08:00", toTime: "10:30" } })
        .success
    ).toBe(true);
    expect(pressingSavedViewSchema.safeParse({ ...view, visibleColumns: ["random_sql_column"] }).success).toBe(false);
    expect(shaped(PRESSING_REPORT_COLUMNS)).toContain(fragmentFor(PRESSING_REPORT_COLUMNS, "secondsSincePrevious"));
    expect(shaped(PRESSING_REPORT_COLUMNS)).toContain(fragmentFor(PRESSING_REPORT_COLUMNS, "bales"));
  });
  it("registers report endpoints after factory authorization boundary", () => {
    expect(shaped(registration)).toContain(fragmentFor(registration, "registerFactoryPressingReportRoutes(app)"));
    expect(codeShape(registration).indexOf(codeShape('app.use("/api/factory", enforceFactoryBackendAccess)'))).toBeLessThan(
      codeShape(registration).indexOf(codeShape("registerFactoryPressingReportRoutes(app)"))
    );
    expect(shaped(server)).toContain(fragmentFor(server, 'app.get("/api/factory/pressing-machines/report", requireAuth'));
    expect(shaped(server)).toContain(fragmentFor(server, 'app.get("/api/factory/pressing-machines/report/options", requireAuth'));
    expect(shaped(server)).toContain(fragmentFor(server, 'app.get("/api/factory/pressing-machines/report/views", requireAuth'));
    expect(shaped(server)).toContain(fragmentFor(server, 'app.post("/api/factory/pressing-machines/report/views", requireAuth'));
  });
  it("enforces current company and operator-only row access on all filtered history", () => {
    expect(shaped(server)).toContain(fragmentFor(server, "getActiveCompanyPermissionContext(req)"));
    expect(shaped(server)).toContain(fragmentFor(server, 'const where: string[] = ["c.company_id = $1"]'));
    expect(shaped(server)).toContain(fragmentFor(server, "if (!ctx.supervisor)"));
    expect(shaped(server)).toContain(fragmentFor(server, "Operators can view only their own records"));
    expect(shaped(server)).toContain(fragmentFor(server, 'push("c.user_id = ?", ctx.userId)'));
    expect(shaped(server)).toContain(fragmentFor(server, "eq(factoryPressingSavedViews.userId, ctx.userId)"));
    expect(shaped(server)).toContain(fragmentFor(server, "eq(factoryPressingSavedViews.companyId, ctx.companyId)"));
    expect(shaped(server)).toContain(fragmentFor(server, "MANAGER_ROLES.has(ctx.role) && !ctx.posViewOnly"));
  });
  it("uses accepted server confirmations with no inventory or queue changes", () => {
    expect(shaped(server)).toContain(fragmentFor(server, "FROM factory_pressing_confirmations c"));
    expect(shaped(server)).toContain(fragmentFor(server, "c.voided_at IS NULL"));
    expect(shaped(server)).toContain(fragmentFor(server, "COUNT(*) FILTER (WHERE c.voided_at IS NULL)"));
    expect(shaped(server)).toContain(fragmentFor(server, "SUM(c.weight_kg) FILTER (WHERE c.voided_at IS NULL)"));
    expect(shaped(server)).toContain(fragmentFor(server, "COUNT(*) FILTER (WHERE c.voided_at IS NOT NULL)"));
    expect(shaped(server)).not.toContain(fragmentFor(server, "factory_bales SET"));
    expect(shaped(server)).not.toContain(fragmentFor(server, "adjustInventory"));
    expect(shaped(server)).not.toContain(fragmentFor(server, "writeDaybookEntry"));
  });
  it("uses filtered date, shift, article, search and machine with stable page anchor", () => {
    expect(shaped(server)).toContain(fragmentFor(server, "c.confirmed_at >= (?::date::timestamp AT TIME ZONE"));
    expect(shaped(server)).toContain(fragmentFor(server, "c.confirmed_at < ((?::date + 1)::timestamp AT TIME ZONE"));
    expect(shaped(server)).toContain(fragmentFor(server, "if (filters.fromTime)"));
    expect(shaped(server)).toContain(fragmentFor(server, "if (filters.toTime)"));
    expect(shaped(server)).toContain(fragmentFor(server, "c.confirmed_at >= (?::timestamp AT TIME ZONE"));
    expect(shaped(server)).toContain(fragmentFor(server, "interval '1 minute'"));
    expect(shaped(server)).toContain(fragmentFor(server, "invalidDateTimeRange(body.filters)"));
    expect(shaped(server)).toContain(fragmentFor(server, "const PRESSING_LOCAL_DATE_SQL"));
    expect(server).toMatch(/GROUP BY ["'] \+\s*PRESSING_LOCAL_DATE_SQL/);
    expect(shaped(server)).toContain(fragmentFor(server, 'push("c.machine_id = ?", filters.machineId)'));
    expect(shaped(server)).toContain(fragmentFor(server, 'push("c.weight_kg = ?::numeric", filters.weightKg)'));
    expect(shaped(server)).toContain(fragmentFor(server, 'push("c.shift_id = ?", filters.shiftId)'));
    expect(shaped(server)).toContain(fragmentFor(server, "filters.articleCode"));
    expect(shaped(server)).toContain(fragmentFor(server, "filters.search"));
    expect(shaped(server)).toContain(fragmentFor(server, "const asOf = filters.asOf ?? new Date().toISOString()"));
    expect(shaped(server)).toContain(fragmentFor(server, 'COUNT(*)::integer AS "bales"'));
    expect(shaped(server)).toContain(fragmentFor(server, 'c.product_name AS "productName"'));
    expect(shaped(server)).toContain(fragmentFor(server, "c.article_code,c.product_name,(c.voided_at IS NOT NULL)"));
    expect(shaped(server)).toContain(fragmentFor(server, "const pageArgs = [...args, filters.limit, (filters.page - 1) * filters.limit]"));
  });
  it("calculates previous-machine intervals outside the visible filter and indexes lookup", () => {
    expect(shaped(server)).toContain(fragmentFor(server, "p.machine_id = c.machine_id"));
    expect(shaped(server)).toContain(fragmentFor(server, "p.voided_at IS NULL"));
    expect(shaped(server)).toContain(fragmentFor(server, 'AS "secondsSincePrevious"'));
    expect(shaped(indexSql)).toContain(fragmentFor(indexSql, "factory_pressing_confirmations_machine_time_idx"));
    expect(shaped(indexSql)).toContain(fragmentFor(indexSql, "confirmed_at DESC, id DESC"));
    expect(shaped(stage)).toContain(fragmentFor(stage, "factory_pressing_confirmations_machine_time_idx"));
  });
  it("has a company-scoped history UI, saved filters, paginated rows and export", () => {
    expect(shaped(parent)).toContain(fragmentFor(parent, "<PressingHistoryReport"));
    expect(shaped(parent)).toContain(fragmentFor(parent, 'key={companyId + ":" + userId}'));
    expect(shaped(page)).toContain(fragmentFor(page, "This Month"));
    expect(shaped(page)).toContain(fragmentFor(page, "All Time"));
    expect(shaped(page)).toContain(fragmentFor(page, 'aria-label="From time (Beirut)"'));
    expect(shaped(page)).toContain(fragmentFor(page, 'aria-label="To time (Beirut)"'));
    expect(shaped(page)).toContain(fragmentFor(page, "pressing-kpi-approx-all"));
    expect(shaped(page)).toContain(fragmentFor(page, "approx40KgText(worker.kg)"));
    expect(shaped(page)).toContain(fragmentFor(page, "approx40KgText(allWorkerKg)"));
    expect(shaped(client)).toContain(fragmentFor(client, 'filters.fromTime ? " " + filters.fromTime'));
    expect(shaped(page)).toContain(fragmentFor(page, 'aria-label="Pressing user filter"'));
    expect(shaped(page)).toContain(fragmentFor(page, "All users"));
    expect(shaped(page)).toContain(fragmentFor(page, "Scanned Items"));
    expect(shaped(page)).toContain(fragmentFor(page, '<th className="p-3">Product name</th>'));
    expect(shaped(page)).toContain(fragmentFor(page, '{row.productName || "—"}'));
    expect(shaped(page)).toContain(fragmentFor(page, '"operatorName", "productName", "bales"'));
    expect(shaped(page)).toContain(fragmentFor(page, "useState(false)"));
    expect(shaped(page)).toContain(fragmentFor(page, 'aria-label="Pressing KG filter"'));
    expect(shaped(page)).toContain(fragmentFor(page, "pressing-kpi-"));
    expect(shaped(page)).toContain(fragmentFor(page, 'mode: "condensed"'));
    expect(shaped(page)).toContain(fragmentFor(page, "const allWorkerBales = workers.reduce"));
    expect(shaped(client)).toContain(fragmentFor(client, "item.isPressingWorker === true && item.username?.trim().toUpperCase() === slot"));
    expect(shaped(client)).toContain(fragmentFor(client, "operator?.displayName?.trim()"));
    expect(shaped(page)).toContain(fragmentFor(page, "pressingKpiWorkers(operators, byOperator)"));
    expect(shaped(page)).toContain(fragmentFor(page, 'data-testid={"pressing-kpi-display-name-" + worker.slot.toLowerCase()}'));
    expect(shaped(server)).toContain(fragmentFor(server, 'AS "displayName"'));
    expect(shaped(server)).toContain(fragmentFor(server, "FROM factory_user_profiles WHERE company_id = $1"));
    expect(shaped(server)).toContain(fragmentFor(server, "operatorName: displayName(row.operatorUserId)"));
    expect(shaped(server)).toContain(fragmentFor(server, "name: displayName(row.userId)"));
    expect(shaped(page)).toContain(fragmentFor(page, 'operator.displayName?.trim() || "Display name not set"'));
    expect(shaped(client)).toContain(fragmentFor(client, 'row.operatorName?.trim() || "Display name not set"'));
    expect(shaped(server)).toContain(fragmentFor(server, "overview"));
    expect(shaped(server)).toContain(fragmentFor(server, "byOperatorSqlFor"));
    expect(shaped(page)).toContain(fragmentFor(page, "Export Excel"));
    expect(shaped(page)).toContain(fragmentFor(page, "queryClient.invalidateQueries"));
    expect(shaped(client)).toContain(fragmentFor(client, "XLSX.writeFile"));
    expect(shaped(client)).toContain(fragmentFor(client, "first.total > PRESSING_EXPORT_LIMIT"));
    expect(shaped(client)).toContain(fragmentFor(client, "asOf: first.asOf"));
  });
});
