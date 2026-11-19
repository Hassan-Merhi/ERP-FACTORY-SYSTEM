import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  querySql: "",
  params: [] as unknown[],
}));

vi.mock("../server/db", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  return {
    db: {
      execute: vi.fn(async (query: never) => {
        const compiled = dialect.sqlToQuery(query);
        fake.querySql = compiled.sql;
        fake.params = compiled.params;
        return { rows: fake.rows };
      }),
    },
  };
});

import { loadFactoryNetPositionEmployees } from "../server/services/factory/netPositionEmployees";
import type { FactoryNetPositionAsOf } from "../shared/factoryNetPositionAsOf";

const historic: FactoryNetPositionAsOf = {
  asOf: "2026-10-19",
  businessToday: "2026-10-21",
  isHistorical: true,
  timeZone: "Asia/Beirut",
  historyBasis: "known-at-cutoff",
};

describe("Factory Net Position dated employees", () => {
  beforeEach(() => {
    fake.rows = [];
    fake.querySql = "";
    fake.params = [];
  });

  it("reconstructs signed balances from opening + period movement, independently of current cache", async () => {
    fake.rows = [
      { id: 1, first_name: "Employee", last_name: "Receivable", code: "ER1", opening: "0", movement: "-100.00" },
      { id: 2, first_name: "Employee", last_name: "Payable", code: "EP2", opening: "50.00", movement: "25.00" },
      { id: 3, first_name: "Employee", last_name: "Cleared", code: "EC3", opening: "15.00", movement: "-15.00" },
    ];

    const result = await loadFactoryNetPositionEmployees(12, historic);
    expect(result).toEqual([
      { id: 1, name: "Employee Receivable", code: "ER1", balance: -100 },
      { id: 2, name: "Employee Payable", code: "EP2", balance: 75 },
      { id: 3, name: "Employee Cleared", code: "EC3", balance: 0 },
    ]);
  });

  it("requires BOTH effective date and recorded time for employee movement and entry", async () => {
    await loadFactoryNetPositionEmployees(12, historic);
    expect(fake.querySql).toContain("v.effective_date");
    expect(fake.querySql).toContain("v.created_at");
    expect(fake.querySql).toContain("ve.created_at");
    expect(fake.querySql).toContain("e.created_at");
    expect(fake.querySql).toContain("v.deleted_at");
    expect(fake.querySql).toContain("AT TIME ZONE");
    expect(fake.params).toContain("2026-10-19");
    expect(fake.params).toContain("Asia/Beirut");
    expect(fake.querySql).not.toContain("e.current_balance");
  });
});
