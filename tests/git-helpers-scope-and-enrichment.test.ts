/**
 * GIT (Global In-Transit) read helpers: company scope resolution, the
 * transporter offload window, delay/overdue/docs flags, filters, the summary
 * and the active-container query shape. Membership, the database and the
 * Supplier Partner feed are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accessible: vi.fn(),
  erpRows: [] as unknown[],
  nameRows: [] as unknown[],
  selects: 0,
  spCalls: [] as unknown[][],
}));

vi.mock("../server/security/companyAccessBoundary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/security/companyAccessBoundary")>()),
  getAccessibleCompanyIds: (...a: unknown[]) => h.accessible(...a),
}));
vi.mock("../server/db", () => ({
  db: {
    select: () => {
      h.selects += 1;
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: async () => h.erpRows,
        then: (resolve: (v: unknown) => unknown) => resolve(h.nameRows),
      };
      return chain;
    },
  },
}));
vi.mock("../server/lib/spGitTracking", () => ({
  fetchSpGitContainers: async (...a: unknown[]) => {
    h.spCalls.push(a);
    return [{ id: -4, companyId: 1, containerNumber: "SP-1" }];
  },
}));

import {
  applyGitFilters,
  buildSummary,
  calcDaysDelayed,
  calcDocsReadyNotSent,
  calcIsOverdue,
  calcMaxOffloadDate,
  enrichContainers,
  fetchActiveContainers,
  loadCompanyNames,
  resolveGitCompanyScope,
  type EnrichedContainer,
  type RawContainerRow,
} from "../server/lib/gitHelpers";

beforeEach(() => {
  h.accessible.mockReset().mockResolvedValue(new Set([3, 1, 2]));
  h.erpRows = [];
  h.nameRows = [];
  h.selects = 0;
  h.spCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveGitCompanyScope", () => {
  const forbidden = {
    error: "Cross-company access requires a privileged role",
    status: 403,
    code: "CROSS_COMPANY_FORBIDDEN",
  };
  const denied = { error: "No access to this company", status: 403, code: "COMPANY_ACCESS_DENIED" };

  it("gives privileged roles every accessible company, sorted", async () => {
    await expect(resolveGitCompanyScope("u", "Owner", { allCompanies: "true" }, 1)).resolves.toEqual({
      mode: "all",
      companyIds: [1, 2, 3],
    });
    expect(h.accessible).toHaveBeenCalledWith("u");
    await expect(resolveGitCompanyScope("u", "Manager", { allCompanies: "true" }, 1)).resolves.toEqual(forbidden);
  });

  it("allows another requested company only to privileged roles with access", async () => {
    await expect(resolveGitCompanyScope("u", "Admin", { companyId: " 2 " }, 1)).resolves.toEqual({
      mode: "single",
      companyId: 2,
    });
    await expect(resolveGitCompanyScope("u", "Manager", { companyId: "1" }, 1)).resolves.toEqual({
      mode: "single",
      companyId: 1,
    });
    await expect(resolveGitCompanyScope("u", "Manager", { companyId: "2" }, 1)).resolves.toEqual(forbidden);
    await expect(resolveGitCompanyScope("u", "Developer", { companyId: "9" }, 1)).resolves.toEqual(denied);
    // An array-valued companyId is ignored in favour of the session company.
    await expect(resolveGitCompanyScope("u", "Manager", { companyId: ["2"] }, 3)).resolves.toEqual({
      mode: "single",
      companyId: 3,
    });
  });

  it("falls back to the session company and reports access errors", async () => {
    await expect(resolveGitCompanyScope("u", "Manager", {}, 9)).resolves.toEqual(denied);
    await expect(resolveGitCompanyScope("u", "Manager", {}, undefined)).resolves.toEqual({
      error: "activeCompanyId must be a positive integer",
      status: 400,
      code: "INVALID_COMPANY_ID",
    });
    await expect(resolveGitCompanyScope("u", "Admin", { companyId: "x" }, 1)).resolves.toEqual({
      error: "requestedCompanyId must be a positive integer",
      status: 400,
      code: "INVALID_COMPANY_ID",
    });
    h.accessible.mockRejectedValueOnce(new Error("db down"));
    await expect(resolveGitCompanyScope("u", "Admin", {}, 1)).resolves.toEqual({
      error: "Unable to resolve company access",
      status: 500,
      code: "COMPANY_CONTEXT_FAILED",
    });
  });
});

describe("calculation helpers", () => {
  it("adds each transporter's offload window to the border date", () => {
    expect(calcMaxOffloadDate("2026-10-01", " farhat ")).toBe("2026-10-12");
    expect(calcMaxOffloadDate("2026-10-01", "Continental")).toBe("2026-10-12");
    expect(calcMaxOffloadDate("2026-10-01", "TRH")).toBe("2026-10-15");
    expect(calcMaxOffloadDate("2026-10-01", "Other")).toBe("2026-10-15");
    expect(calcMaxOffloadDate("2026-10-01", null)).toBe("2026-10-15");
    expect(calcMaxOffloadDate(null, "TRH")).toBeNull();
    expect(calcMaxOffloadDate("not a date", "TRH")).toBeNull();
  });

  it("counts whole days at port only while no truck is assigned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 15, 30));
    expect(calcDaysDelayed(new Date(2026, 9, 17).toISOString(), null)).toBe(3);
    expect(calcDaysDelayed(new Date(2026, 9, 17).toISOString(), "  ")).toBe(3);
    expect(calcDaysDelayed(new Date(2026, 9, 17).toISOString(), "ABC 123")).toBeNull();
    expect(calcDaysDelayed(new Date(2026, 9, 20).toISOString(), null)).toBeNull();
    expect(calcDaysDelayed(new Date(2026, 9, 25).toISOString(), null)).toBeNull();
    expect(calcDaysDelayed(null, null)).toBeNull();
    expect(calcDaysDelayed("garbage", null)).toBeNull();
  });

  it("flags received documents not yet sent", () => {
    expect(calcDocsReadyNotSent(true, null)).toBe(true);
    expect(calcDocsReadyNotSent(true, "2026-10-01")).toBe(false);
    expect(calcDocsReadyNotSent(false, null)).toBe(false);
    expect(calcDocsReadyNotSent(null, null)).toBe(false);
  });

  it("marks active containers past their offload date as overdue", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 9));
    const yesterday = new Date(2026, 9, 19).toISOString();
    expect(calcIsOverdue(yesterday, "At Border")).toBe(true);
    expect(calcIsOverdue(new Date(2026, 9, 20).toISOString(), "At Border")).toBe(false);
    for (const status of ["Offloaded", "OFFLOADED", "Closed", "COMPLETED"]) {
      expect(calcIsOverdue(yesterday, status)).toBe(false);
    }
    expect(calcIsOverdue(null, "Sea")).toBe(false);
    expect(calcIsOverdue("garbage", "Sea")).toBe(false);
  });
});

const raw = (over: Partial<RawContainerRow> = {}) =>
  ({
    id: 1,
    companyId: 1,
    containerNumber: "MSKU1",
    status: "Sea",
    eta: null,
    transporter: null,
    agent: null,
    shopName: null,
    trackingLocation: null,
    numberPlate: null,
    borderDate: null,
    docReceived: null,
    docsSentDate: null,
    ...over,
  }) as RawContainerRow;

describe("enrichContainers", () => {
  it("attaches the company name and computed flags", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 12));
    const [named, unnamed] = enrichContainers(
      [
        raw({
          borderDate: "2026-10-01",
          transporter: "TRH",
          eta: new Date(2026, 9, 28).toISOString(),
          docReceived: true,
          status: "At Border",
        }),
        raw({ companyId: 7 }),
      ],
      { 1: "Helium" }
    );
    expect(named).toMatchObject({
      companyName: "Helium",
      maxOffloadDate: "2026-10-15",
      daysDelayed: 2,
      docsReadyNotSent: true,
      isOverdue: true,
    });
    expect(unnamed).toMatchObject({
      companyName: "Company 7",
      maxOffloadDate: null,
      daysDelayed: null,
      docsReadyNotSent: false,
      isOverdue: false,
    });
  });
});

const enriched = (over: Partial<EnrichedContainer> = {}) =>
  ({
    ...raw(),
    companyName: "Helium",
    maxOffloadDate: null,
    daysDelayed: null,
    docsReadyNotSent: false,
    isOverdue: false,
    ...over,
  }) as EnrichedContainer;

describe("applyGitFilters and buildSummary", () => {
  const rows = [
    enriched({
      id: 1,
      containerNumber: "MSKU100",
      status: "Sea",
      transporter: "Farhat",
      agent: "Bolloré",
      trackingLocation: "Dar es Salaam",
      daysDelayed: 4,
      numberPlate: null,
    }),
    enriched({
      id: 2,
      containerNumber: "TGHU200",
      status: "At Border",
      transporter: "TRH",
      agent: "Swift",
      shopName: "Lusaka Main",
      isOverdue: true,
      numberPlate: "ZM 1",
    }),
    enriched({
      id: 3,
      containerNumber: "CMAU300",
      status: "sea",
      docsReadyNotSent: true,
      daysDelayed: 0,
      numberPlate: " ",
    }),
  ];
  const ids = (out: EnrichedContainer[]) => out.map((r) => r.id);

  it("filters by each field, case-insensitively, and combines filters", () => {
    expect(ids(applyGitFilters(rows, {}))).toEqual([1, 2, 3]);
    expect(ids(applyGitFilters(rows, { status: "SEA" }))).toEqual([1, 3]);
    expect(ids(applyGitFilters(rows, { transporter: "far" }))).toEqual([1]);
    expect(ids(applyGitFilters(rows, { agent: "SWI" }))).toEqual([2]);
    expect(ids(applyGitFilters(rows, { location: "dar" }))).toEqual([1]);
    expect(ids(applyGitFilters(rows, { search: "tghu" }))).toEqual([2]);
    expect(ids(applyGitFilters(rows, { q: "lusaka" }))).toEqual([2]);
    expect(ids(applyGitFilters(rows, { search: "cmau", q: "lusaka" }))).toEqual([3]);
    expect(ids(applyGitFilters(rows, { docsReady: "true" }))).toEqual([3]);
    expect(ids(applyGitFilters(rows, { delayed: "true" }))).toEqual([1]);
    expect(ids(applyGitFilters(rows, { overdue: "true" }))).toEqual([2]);
    expect(ids(applyGitFilters(rows, { docsReady: "false", delayed: "1", overdue: "yes" }))).toEqual([1, 2, 3]);
    expect(ids(applyGitFilters(rows, { status: "sea", transporter: "farhat" }))).toEqual([1]);
  });

  it("counts statuses, delays, overdue, ready documents and trucks", () => {
    expect(buildSummary(rows)).toEqual({
      total: 3,
      byStatus: { Sea: 1, "At Border": 1, sea: 1 },
      delayed: 1,
      overdue: 1,
      docsReadyNotSent: 1,
      withTruck: 1,
      withoutTruck: 2,
    });
    expect(buildSummary([])).toEqual({
      total: 0,
      byStatus: {},
      delayed: 0,
      overdue: 0,
      docsReadyNotSent: 0,
      withTruck: 0,
      withoutTruck: 0,
    });
  });
});

describe("database helpers", () => {
  it("returns ERP rows followed by Supplier Partner rows", async () => {
    h.erpRows = [{ id: 5, companyId: 1, containerNumber: "ERP-1" }];
    const out = await fetchActiveContainers([1], { includeOffloaded: true });
    expect(out.map((r) => r.containerNumber)).toEqual(["ERP-1", "SP-1"]);
    expect(h.spCalls).toEqual([[[1], { includeOffloaded: true }]]);
    expect(h.selects).toBe(1);
  });

  it("skips the ERP query for no companies or a Supplier Partner container id", async () => {
    expect(await fetchActiveContainers([])).toEqual([]);
    expect(h.spCalls).toEqual([]);
    const out = await fetchActiveContainers([1], { containerId: -4 });
    expect(out.map((r) => r.id)).toEqual([-4]);
    expect(h.selects).toBe(0);
    await fetchActiveContainers([1], { containerId: 5 });
    expect(h.selects).toBe(1);
  });

  it("maps company ids to names", async () => {
    expect(await loadCompanyNames([])).toEqual({});
    expect(h.selects).toBe(0);
    h.nameRows = [
      { id: 1, name: "Helium" },
      { id: 2, name: "Zambia" },
    ];
    expect(await loadCompanyNames([1, 2])).toEqual({ 1: "Helium", 2: "Zambia" });
  });
});
