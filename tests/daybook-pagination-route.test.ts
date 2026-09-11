import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  assignedLocations: [{ locationId: 17 }, { locationId: 18 }],
  poolQuery: vi.fn(),
}));

vi.mock("../server/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../server/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => harness.assignedLocations }) }),
  },
  pool: { query: harness.poolQuery },
}));
vi.mock("@shared/schema", () => ({
  userLocations: {
    userId: "userLocations.userId",
    companyId: "userLocations.companyId",
    locationId: "userLocations.locationId",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

import { registerDaybookPaginationRoutes } from "../server/routes/daybookPaginationRoutes";

describe("ERP Daybook pagination route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    harness.poolQuery.mockResolvedValue({
      rows: [
        {
          total: 251,
          items: [
            { _type: "voucher", data: { id: 1, voucherType: "Receipt" } },
            { _type: "offload", data: { id: 2, containerNumber: "CNT-2" } },
          ],
        },
      ],
    });
    registerDaybookPaginationRoutes({
      get: (path: string, ...callbacks: Array<(...args: any[]) => unknown>) => {
        harness.handlers.set(path, callbacks.at(-1)!);
      },
    } as never);
  });

  it("returns a server-filtered POS page with scoped filters and stable pagination metadata", async () => {
    const req = {
      session: { currentCompanyId: 4, currentRole: "POS" },
      user: { id: "user-7" },
      query: {
        startDate: "2026-08-01",
        endDate: "2026-08-11",
        voucherType: "Receipt",
        statusFilter: "active",
        search: "riverside",
        minAmount: "10",
        maxAmount: "500",
        offset: "250",
        limit: "500",
        sortOrder: "asc",
      },
    };
    const headers = new Map<string, string>();
    const res = {
      status: vi.fn(),
      json: vi.fn(),
      setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
    };
    res.status.mockReturnValue(res);

    await harness.handlers.get("/api/daybook")!(req, res);

    expect(res.json).toHaveBeenCalledWith({
      items: [
        { _type: "voucher", data: { id: 1, voucherType: "Receipt" } },
        { _type: "offload", data: { id: 2, containerNumber: "CNT-2" } },
      ],
      total: 251,
      page: 2,
      limit: 250,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });
    expect(headers.get("X-Total-Count")).toBe("251");
    expect(headers.get("X-Page")).toBe("2");
    expect(headers.get("X-Page-Size")).toBe("250");
    expect(headers.get("X-Total-Pages")).toBe("2");
    const [query, values] = harness.poolQuery.mock.calls[0];
    expect(query).toContain("v.voucher_type =");
    expect(query).toContain("v.optional = false");
    expect(query).toContain("v.location_id = ANY");
    expect(query).toContain("ORDER BY sort_date ASC");
    expect(values).toEqual(
      expect.arrayContaining([4, "2026-08-01", "2026-08-11", "Receipt", "%riverside%", 10, 500, [17, 18], true, 250])
    );
  });

  it("returns deterministic keyset chunks and reuses the first-chunk total", async () => {
    process.env.CONTINUOUS_CURSOR_SECRET = "daybook-wave-two-secret-1234";
    harness.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          total: 3,
          items: [
            { _type: "voucher", data: { id: 10, voucherType: "Sales" } },
            { _type: "voucher", data: { id: 11, voucherType: "Sales" } },
          ],
          has_more: true,
          last_cursor: { sortDate: "2026-08-11", typeRank: 2, sortId: 11 },
        },
      ],
    });
    const firstReq = {
      session: { currentCompanyId: 4, currentRole: "Admin" },
      user: { id: "user-7" },
      query: {
        startDate: "2026-08-01",
        endDate: "2026-08-11",
        continuous: "1",
        limit: "2",
        sortOrder: "asc",
      },
    };
    const firstRes = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    firstRes.status.mockReturnValue(firstRes);

    await harness.handlers.get("/api/daybook")!(firstReq, firstRes);

    const firstPayload = firstRes.json.mock.calls[0][0];
    expect(firstPayload).toMatchObject({ total: 3, limit: 2, hasMore: true });
    expect(firstPayload.nextCursor).toEqual(expect.any(String));
    const firstSql = String(harness.poolQuery.mock.calls[0][0]);
    expect(firstSql).toContain("chunk_rows AS");
    expect(firstSql).toContain("COUNT(*)::int FROM combined");
    expect(firstSql).toContain("ORDER BY sort_date ASC, type_rank ASC, sort_id ASC");

    harness.poolQuery.mockResolvedValueOnce({
      rows: [{ total: 3, items: [{ _type: "offload", data: { id: 90 } }], has_more: false, last_cursor: null }],
    });
    const secondReq = {
      ...firstReq,
      query: { ...firstReq.query, cursor: firstPayload.nextCursor },
    };
    const secondRes = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    secondRes.status.mockReturnValue(secondRes);

    await harness.handlers.get("/api/daybook")!(secondReq, secondRes);

    const [secondSql, secondValues] = harness.poolQuery.mock.calls[1];
    expect(secondSql).toContain("sort_date >");
    expect(secondSql).toContain("type_rank >");
    expect(secondSql).toContain("sort_id >");
    expect(secondSql).not.toContain("COUNT(*)::int FROM combined");
    expect(secondValues).toEqual(expect.arrayContaining(["2026-08-11", 2, 11, 3]));
    expect(secondRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ total: 3, hasMore: false, nextCursor: null })
    );
    delete process.env.CONTINUOUS_CURSOR_SECRET;
  });

  it("rejects an unscoped request before issuing SQL", async () => {
    const req = { session: {}, query: {} };
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);

    await harness.handlers.get("/api/daybook")!(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "No company selected" });
    expect(harness.poolQuery).not.toHaveBeenCalled();
  });
});
