import { AsyncLocalStorage } from "node:async_hooks";

export type TenantDatabaseScopeMode = "active-company" | "authorized-companies";

export type TenantDatabaseScopeRuntimeContext = {
  kind: "tenant";
  companyId: number;
  authorizedCompanyIds: readonly number[];
  scopeMode: TenantDatabaseScopeMode;
};

export type MaintenanceDatabaseScopeRuntimeContext = {
  kind: "maintenance";
  reason: string;
};

export type DatabaseScopeRuntimeContext = TenantDatabaseScopeRuntimeContext | MaintenanceDatabaseScopeRuntimeContext;

const databaseScopeRuntime = new AsyncLocalStorage<DatabaseScopeRuntimeContext>();

function positiveCompanyId(value: unknown): number {
  const companyId = Number(value);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("database_tenant_scope_requires_positive_company_id");
  }
  return companyId;
}

export function createTenantDatabaseScope(
  companyIdValue: unknown,
  authorizedCompanyIdValues: readonly unknown[] = [],
  scopeMode: TenantDatabaseScopeMode = "active-company"
): TenantDatabaseScopeRuntimeContext {
  const companyId = positiveCompanyId(companyIdValue);
  const authorizedCompanyIds = [...new Set(authorizedCompanyIdValues.map(positiveCompanyId))]
    .filter((authorizedCompanyId) => authorizedCompanyId !== companyId)
    .sort((left, right) => left - right);

  return {
    kind: "tenant",
    companyId,
    authorizedCompanyIds,
    scopeMode,
  };
}

export function createMaintenanceDatabaseScope(reason: string): MaintenanceDatabaseScopeRuntimeContext {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new Error("database_maintenance_scope_requires_reason");
  }
  return { kind: "maintenance", reason: normalizedReason };
}

export function runWithDatabaseScopeRuntimeContext<T>(context: DatabaseScopeRuntimeContext, callback: () => T): T {
  return databaseScopeRuntime.run(context, callback);
}

export function runWithDatabaseMaintenanceScope<T>(reason: string, callback: () => T): T {
  const currentContext = databaseScopeRuntime.getStore();
  if (currentContext?.kind === "tenant") {
    throw new Error("database_tenant_maintenance_elevation_forbidden");
  }

  return runWithDatabaseScopeRuntimeContext(createMaintenanceDatabaseScope(reason), callback);
}

export function getDatabaseScopeRuntimeContext(): DatabaseScopeRuntimeContext | undefined {
  return databaseScopeRuntime.getStore();
}

/**
 * Runs `callback` with no database scope at all (whatever scope the caller is
 * in). The backend test app uses it as its first middleware so a request starts
 * unscoped exactly as in production, even when the test that sends it runs in
 * the fixture maintenance scope (tests/rlsFixtureScope.mjs).
 */
export function runOutsideDatabaseScope<T>(callback: () => T): T {
  return databaseScopeRuntime.exit(callback);
}

/**
 * Tests only (tests/rlsFixtureScope.mjs, opt-in): enters `context` for the rest
 * of the current asynchronous execution, so fixture SQL of a suite run as a
 * non-superuser role (RLS enforced) is written in the maintenance scope.
 */
export function enterDatabaseScopeRuntimeContextForTests(context: DatabaseScopeRuntimeContext): void {
  if (process.env.NODE_ENV !== "test") throw new Error("database_scope_enter_is_test_only");
  databaseScopeRuntime.enterWith(context);
}
