/**
 * Production forces company-scope RLS, so the ledger guard install (whose
 * parent foreign key validation reads every company's accounts) failed with
 * "app.current_company_id is required for tenant data access". The installer
 * must enter the maintenance scope, transaction-locally, before any DDL.
 */
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  ensureLedgerIntegrityGuard,
  LEDGER_INTEGRITY_GUARD_DDL,
} from "../server/services/accounting/ledgerIntegrityGuard";

describe("ledger integrity guard install scope", () => {
  it("sets the maintenance scope for its own transaction before the DDL", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = { connect: async () => client } as unknown as Pool;

    expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);

    const scope = queries.findIndex((q) => q.includes("set_config('app.company_scope_maintenance', 'on', true)"));
    const firstDdl = queries.indexOf(LEDGER_INTEGRITY_GUARD_DDL[0]);
    expect(queries.indexOf("BEGIN")).toBeLessThan(scope);
    expect(scope).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(firstDdl);
    expect(queries[scope]).toContain("set_config('app.current_company_id', '', true)");
    expect(queries.at(-1)).toBe("COMMIT");
  });
});
