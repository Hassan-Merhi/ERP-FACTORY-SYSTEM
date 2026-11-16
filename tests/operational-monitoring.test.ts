import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 11 operational monitoring contracts", () => {
  it("protects the monitoring endpoint and keeps it read-only", () => {
    const routes = source("server/routes/admin/operationalMonitoringRoutes.ts");
    expect(routes).toContain('app.get(');
    expect(routes).toContain('"/api/admin/operational-monitoring"');
    expect(routes).toContain("requireAuth");
    expect(routes).toContain('requireRole("Admin", "Owner")');
    expect(routes).not.toContain("app.post(");
    expect(routes).not.toContain("app.delete(");
  });

  it("evaluates error, latency, pool, memory, and critical-event thresholds", () => {
    const service = source("server/services/operations/operationalHealthService.ts");
    for (const code of [
      "http_server_error_rate",
      "slow_request_rate",
      "database_pool_waiting",
      "heap_usage",
      "recent_critical_events",
    ]) {
      expect(service).toContain(code);
    }
    expect(service).toContain("OPS_SERVER_ERROR_WARNING_PERCENT");
    expect(service).toContain("OPS_HEAP_CRITICAL_MB");
  });

  it("registers the focused route from the public composition root", () => {
    const routes = source("server/routes.ts");
    expect(routes).toContain("registerOperationalMonitoringRoutes(app)");
  });

  it("never exposes sensitive request or database payload fields", () => {
    const route = source("server/routes/admin/operationalMonitoringRoutes.ts");
    expect(route).toContain("never returns request bodies");
    expect(route).toContain("authorization headers");
    expect(route).toContain("SQL text");
    expect(route).toContain("bound database parameters");
  });
});
