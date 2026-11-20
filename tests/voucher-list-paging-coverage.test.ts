import { describe, expect, it } from "vitest";

import {
  buildVoucherPage,
  filterAndSortVouchers,
  parseVoucherListQuery,
  toCompactVoucher,
} from "../server/routes/vouchers/voucherListPaging";

describe("parseVoucherListQuery", () => {
  it("defaults page and size and is not paginated without paging hints", () => {
    const parsed = parseVoucherListQuery({});
    expect(parsed).toEqual({
      ok: true,
      query: expect.objectContaining({ page: 1, pageSize: 100, paginated: false, startDate: undefined }),
    });
  });

  it("rejects malformed, impossible and reversed dates", () => {
    expect(parseVoucherListQuery({ startDate: "2026/01/01" })).toEqual({ ok: false, message: "Invalid startDate" });
    expect(parseVoucherListQuery({ startDate: "2026-02-30" })).toEqual({ ok: false, message: "Invalid startDate" });
    expect(parseVoucherListQuery({ endDate: "nope" })).toEqual({ ok: false, message: "Invalid endDate" });
    expect(parseVoucherListQuery({ startDate: "2026-03-02", endDate: "2026-03-01" })).toEqual({
      ok: false,
      message: "startDate must be before endDate",
    });
  });

  it("clamps page size, repairs bad page numbers and stringifies filters", () => {
    const parsed = parseVoucherListQuery({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      page: "-3",
      pageSize: "999",
      type: "sales",
      search: 12,
      status: "active",
      minAmount: 5,
      maxAmount: "10",
      sort: "asc",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query).toMatchObject({
      page: 1,
      pageSize: 200,
      paginated: true,
      type: "sales",
      search: "12",
      status: "active",
      minAmount: "5",
      maxAmount: "10",
      sort: "asc",
    });
    const junk = parseVoucherListQuery({ page: "x", pageSize: "0" });
    expect(junk.ok && junk.query).toMatchObject({ page: 1, pageSize: 100, paginated: true });
    const profile = parseVoucherListQuery({ profile: "page" });
    expect(profile.ok && profile.query).toMatchObject({ paginated: true, profile: "page" });
    const otherProfile = parseVoucherListQuery({ profile: "compact" });
    expect(otherProfile.ok && otherProfile.query.paginated).toBe(false);
  });
});

const rows = [
  { id: 1, voucherType: "sales", voucherDate: "2026-01-02", totalAmount: "50", optional: false, voucherNumber: "S-1" },
  { id: 2, voucherType: "sales", voucherDate: "2026-01-02", totalAmount: "150", optional: true, voucherNumber: "S-2" },
  {
    id: 3,
    voucherType: "receipt",
    voucherDate: "2026-01-01",
    totalAmount: null,
    optional: false,
    voucherNumber: "R-1",
    description: "Cash from Alpha",
  },
  { id: 4, voucherType: "sales", voucherDate: undefined, totalAmount: "20", optional: false, voucherNumber: "S-3" },
];

describe("filterAndSortVouchers", () => {
  it("sorts by date then id, descending by default and ascending on request", () => {
    expect(filterAndSortVouchers(rows, {}).map((r) => r.id)).toEqual([2, 1, 3, 4]);
    expect(filterAndSortVouchers(rows, { sort: "asc", type: "all" }).map((r) => r.id)).toEqual([4, 3, 1, 2]);
  });

  it("filters by type, status, amount range and search text", () => {
    expect(filterAndSortVouchers(rows, { type: "receipt" }).map((r) => r.id)).toEqual([3]);
    expect(filterAndSortVouchers(rows, { status: "active" }).map((r) => r.id)).toEqual([1, 3, 4]);
    expect(filterAndSortVouchers(rows, { status: "optional" }).map((r) => r.id)).toEqual([2]);
    expect(filterAndSortVouchers(rows, { minAmount: "40", maxAmount: "100" }).map((r) => r.id)).toEqual([1]);
    expect(filterAndSortVouchers(rows, { search: "  alpha " }).map((r) => r.id)).toEqual([3]);
  });

  it("ignores unparseable amount bounds instead of filtering everything out", () => {
    expect(filterAndSortVouchers(rows, { minAmount: "abc", maxAmount: "xyz" })).toHaveLength(4);
  });
});

describe("buildVoucherPage", () => {
  it("returns an empty first page when there are no rows", () => {
    expect(buildVoucherPage([], 5, 10)).toMatchObject({
      data: [],
      page: 1,
      total: 0,
      totalPages: 0,
      hasMore: false,
      summary: { total: 0, active: 0, optional: 0 },
    });
  });

  it("clamps the page to the last page and summarises all rows", () => {
    const first = buildVoucherPage(rows, 1, 3);
    expect(first).toMatchObject({ page: 1, totalPages: 2, hasMore: true, total: 4 });
    expect(first.data).toHaveLength(3);
    const last = buildVoucherPage(rows, 9, 3);
    expect(last).toMatchObject({ page: 2, hasMore: false, summary: { active: 3, optional: 1 } });
    expect(Number(last.summary.totalAmount)).toBe(220);
    expect(last.data[0]).toMatchObject({ id: 4, optional: false, description: null, locationId: null });
  });
});

describe("toCompactVoucher", () => {
  it("fills defaults and keeps only true booleans", () => {
    expect(toCompactVoucher({ id: 7, optional: "yes", isCreditSale: true, locationName: "Main" })).toEqual({
      id: 7,
      voucherNumber: undefined,
      voucherType: undefined,
      voucherDate: undefined,
      description: null,
      totalAmount: "0",
      optional: false,
      createdAt: undefined,
      locationId: null,
      locationName: "Main",
      shiftId: null,
      isCreditSale: true,
    });
  });
});
