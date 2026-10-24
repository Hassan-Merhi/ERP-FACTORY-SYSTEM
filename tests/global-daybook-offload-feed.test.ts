import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../server/db", () => ({
  pool: { query: vi.fn() },
}));

import { pool } from "../server/db";
import { getGlobalDaybookFeed } from "../server/routes/global/globalDaybookFeed";

const query = pool.query as unknown as Mock;

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (statement: string) => {
    if (statement.includes("SELECT COUNT(*)::integer AS total")) {
      return { rows: [{ total: 3 }] };
    }
    if (statement.includes("COUNT(DISTINCT")) {
      return {
        rows: [{
          companyId: 1,
          companyName: "HADI L'SHI",
          currency: "USD",
          voucherCount: 3,
          totalDebits: "20000",
          totalCredits: "20000",
        }],
      };
    }
    return {
      rows: [
        { id: 101, entryType: "voucher", voucherType: "Payment", totalAmount: "11500" },
        { id: 102, entryType: "voucher", voucherType: "Payment", totalAmount: "8500" },
        { id: -77, entryType: "offload", offloadId: 77, voucherType: "Offload", totalAmount: "51817" },
      ],
    };
  });
});

describe("All Daybook cross-company offload feed", () => {
  it("paginates actual vouchers together with separate offload events", async () => {
    const result = await getGlobalDaybookFeed({
      targetCompanyIds: [1], startDate: "2026-10-24", endDate: "2026-10-24",
      optional: "active", page: 1, limit: 50,
    });

    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(1);
    expect(result.vouchers.map((entry: { entryType: string }) => entry.entryType))
      .toEqual(["voucher", "voucher", "offload"]);
    expect(result.summary[0]).toMatchObject({
      voucherCount: 3,
      totalDebits: "20000",
    });
    expect(query).toHaveBeenCalledTimes(3);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.every(sql => sql.includes("UNION ALL"))).toBe(true);
    expect(statements.every(sql => sql.includes("c.company_id = ANY($1::integer[])"))).toBe(true);
    expect(statements[0]).toContain('ORDER BY LOWER("companyName") ASC, "companyId" ASC');
    expect(statements[0]).toContain("WHEN LOWER(TRIM(\"voucherType\")) = 'payment' THEN 0");
    expect(statements[0]).toContain("WHEN LOWER(TRIM(\"voucherType\")) = 'journal' THEN 2");
    expect(statements[0]).toContain("WHEN LOWER(TRIM(\"voucherType\")) = 'offload' THEN 6");
    expect(statements[0]).toMatch(/"voucherDate" DESC, id DESC\s+LIMIT/);
    expect(statements[2]).toContain("j.\"entryType\" = 'voucher'");
    expect(statements[2]).toContain("COUNT(DISTINCT");
  });

  it("applies Offload, date, company and optional filters before the union", async () => {
    await getGlobalDaybookFeed({
      targetCompanyIds: [1, 2], voucherType: "Offload", currency: "USD",
      optional: "optional", search: "MRSU9403981",
      startDate: "2026-10-24", endDate: "2026-10-24",
      page: 2, limit: 10,
    });
    const [statement, values] = query.mock.calls[0];
    const sql = String(statement);
    expect(sql).toContain("v.deleted_at IS NULL AND");
    expect(sql).toContain("AND FALSE");
    expect(sql).toContain("co.optional = TRUE");
    expect(sql).toContain("co.offloaded_at");
    expect(sql).toContain("c.container_number ILIKE");
    expect(values[0]).toEqual([1, 2]);
    expect(values).toContain("%MRSU9403981%");
    expect(values.slice(-2)).toEqual([10, 10]);
  });

  it("does not treat non-USD offloads as non-USD vouchers", async () => {
    await getGlobalDaybookFeed({
      targetCompanyIds: [1], currency: "CFA", page: 1, limit: 50,
    });
    expect(String(query.mock.calls[0][0])).toContain("c.company_id = ANY($1::integer[]) AND FALSE");
  });
});
