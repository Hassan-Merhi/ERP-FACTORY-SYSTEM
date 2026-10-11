// Opt-in (TEST_FIXTURE_MAINTENANCE_SCOPE=1): run the backend suite connected as a
// non-superuser role without BYPASSRLS (the production app role's attributes), so
// row-level security is enforced. Fixture SQL written directly by a test (seeding,
// cleanup, assertions) runs in the maintenance scope, as the boot and repair tools
// do; every HTTP request still starts unscoped (tests/setup.ts resets the scope as
// its first middleware) and takes its tenant scope from the application, so a
// route, login or report that reads tenant data outside its company scope fails
// closed here as it would in production. Without the variable this file does
// nothing (CI runs the suite as the database superuser).
import { beforeAll, beforeEach } from "vitest";

if (process.env.TEST_FIXTURE_MAINTENANCE_SCOPE === "1") {
  const { createMaintenanceDatabaseScope, enterDatabaseScopeRuntimeContextForTests } =
    await import("../server/services/security/databaseScopeRuntimeContext");
  const enter = () => enterDatabaseScopeRuntimeContextForTests(createMaintenanceDatabaseScope("test-fixture"));
  enter();
  beforeAll(enter);
  beforeEach(enter);
}
