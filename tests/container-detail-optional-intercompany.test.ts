import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { containerDetailVisibilityCondition } from "../server/lib/containerDetailVisibilityCondition";

const dialect = new PgDialect();

describe("ERP container detail visibility without optional intercompany schema", () => {
  it("queries an owned container without mentioning a missing intercompany relation", () => {
    const query = dialect.sqlToQuery(containerDetailVisibilityCondition(671, 1, false));
    expect(query.sql).toContain('"containers"."id"');
    expect(query.sql).toContain('"containers"."company_id"');
    expect(query.sql).not.toContain("intercompany_trades");
    expect(query.params).toEqual([671, 1]);
  });

  it("includes only explicit active source-to-destination links when the table exists", () => {
    const query = dialect.sqlToQuery(containerDetailVisibilityCondition(671, 2, true));
    expect(query.sql).toContain("intercompany_trades trade");
    expect(query.sql).toContain("trade.physical_container_id");
    expect(query.sql).toContain("trade.destination_company_id");
    expect(query.sql).toContain("trade.source_company_id");
    expect(query.sql).toContain("trade.state = 'active'");
    expect(query.params).toEqual([671, 2, 2]);
  });

  it("does not include linked-company access in owner-only mode", () => {
    const query = dialect.sqlToQuery(containerDetailVisibilityCondition(671, 2, false));
    expect(query.params).toEqual([671, 2]);
    expect(query.sql).not.toContain("EXISTS");
  });
});
