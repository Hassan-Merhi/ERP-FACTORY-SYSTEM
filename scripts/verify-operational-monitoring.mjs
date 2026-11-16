import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const failures = [];

function requireText(relativePath, text) {
  if (!read(relativePath).includes(text)) failures.push(`${relativePath}: missing ${text}`);
}

for (const [file, text] of [
  ["server/routes.ts", "registerOperationalMonitoringRoutes(app)"],
  ["server/routes/admin/operationalMonitoringRoutes.ts", '"/api/admin/operational-monitoring"'],
  ["server/routes/admin/operationalMonitoringRoutes.ts", 'requireRole("Admin", "Owner")'],
  ["server/services/operations/operationalHealthService.ts", "http_server_error_rate"],
  ["server/services/operations/operationalHealthService.ts", "slow_request_rate"],
  ["server/services/operations/operationalHealthService.ts", "database_pool_waiting"],
  ["server/services/operations/operationalHealthService.ts", "heap_usage"],
  ["server/services/operations/operationalHealthService.ts", "recent_critical_events"],
  ["server/lib/operationalEvents.ts", "severityCounts"],
  ["server/lib/operationalEvents.ts", "byCode"],
  ["tests/operational-monitoring.test.ts", "Phase 11 operational monitoring contracts"],
  ["docs/archive/engineering/phase11-operational-monitoring.md", "Verification boundary"],
  ["docs/archive/engineering/phase11-operational-monitoring.md", "Merge boundary"],
]) {
  requireText(file, text);
}

const route = read("server/routes/admin/operationalMonitoringRoutes.ts");
if (route.includes("app.post(") || route.includes("app.delete(") || route.includes("app.patch(")) {
  failures.push("operational monitoring route must remain read-only");
}

if (failures.length) {
  console.error("Phase 11 operational monitoring verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Phase 11 operational monitoring contracts verified.");
