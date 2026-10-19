import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { syncLoadingStartedDaybookTotal } from "./loadingDaybookAmount";

describe("loading started daybook amount synchronization", () => {
  it("updates only the matching USD loading event from the order's authoritative grand total", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const dialect = new PgDialect();
    await syncLoadingStartedDaybookTotal(
      {
        execute: async (query) => {
          statements.push(dialect.sqlToQuery(query));
          return undefined;
        },
      },
      210
    );
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("UPDATE factory_daybook_entries");
    expect(statements[0].sql).toContain("orders.grand_total");
    expect(statements[0].sql).toContain("entry.company_id = orders.company_id");
    expect(statements[0].sql).toContain("entry.reference_id = orders.id");
    expect(statements[0].sql).toContain("entry.tx_type = 'LOADING_CREATED'");
    expect(statements[0].sql).toContain("entry.currency_code = 'USD'");
    expect(statements[0].params).toEqual([210]);
  });
});
