// Extracted from ./db.ts
import { getDatabaseScopeRuntimeContext } from "./services/security/databaseScopeRuntimeContext";

export function desiredDatabaseScope(): {
  signature: string;
  maintenance: "on" | "off";
  companyId: string;
  authorizedCompanyIds: string;
} {
  const context = getDatabaseScopeRuntimeContext();

  if (context?.kind === "maintenance") {
    return {
      signature: "maintenance",
      maintenance: "on",
      companyId: "",
      authorizedCompanyIds: "",
    };
  }

  if (context?.kind === "tenant") {
    const authorizedCompanyIds =
      context.scopeMode === "authorized-companies" ? context.authorizedCompanyIds.join(",") : "";

    return {
      // Ordinary tenant requests stay pinned to the active company. Only
      // server-trusted cross-company surfaces may opt into the already-verified
      // authorized company list; caller-supplied secondary IDs alone never widen
      // the pooled RLS boundary.
      signature:
        context.scopeMode === "authorized-companies"
          ? `tenant-authorized:${context.companyId}:${authorizedCompanyIds}`
          : `tenant:${context.companyId}`,
      maintenance: "off",
      companyId: String(context.companyId),
      authorizedCompanyIds,
    };
  }

  return {
    signature: "unscoped",
    maintenance: "off",
    companyId: "",
    authorizedCompanyIds: "",
  };
}

export const POOL_PRESSURE_GRACE_MS = 250;

/**
 * A row shape for `db.execute` / `tx.execute`.
 *
 * Drizzle constrains that generic to `Record<string, unknown>`. Wrapping a
 * precise row interface here at the call site keeps the interface itself free
 * of a catch-all index signature, which would otherwise hide a misspelled
 * column in every consumer of the result.
 */
export type RawQueryRow<TRow> = TRow & Record<string, unknown>;
