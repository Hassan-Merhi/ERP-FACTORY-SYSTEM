import { describe, expect, it } from "vitest";
import type { EnrichedContainer } from "../server/lib/gitHelpers";
import {
  applyGitTableFilters,
  buildGitFacets,
  buildGitTableSummary,
  parseGitPagination,
  sortGitRows,
  toGitCompactRow,
} from "../server/routes/git/gitListingProfiles";

function row(overrides: Partial<EnrichedContainer>): EnrichedContainer {
  return {
    containerNumber: "C1",
    companyName: "Alpha",
    shopName: null,
    status: "OTW",
    transporter: null,
    agent: null,
    numberPlate: null,
    trackingLocation: null,
    supplierCode: null,
    docReceived: false,
    docsReadyNotSent: false,
    daysDelayed: null,
    isOverdue: false,
    poFreight: null,
    eta: null,
    trackingDescription: null,
    grandTotal: null,
    transportFee: null,
    dutyFee: null,
    ...overrides,
  } as unknown as EnrichedContainer;
}

const a = row({
  containerNumber: "A1",
  companyName: "Alpha",
  shopName: "Shop 10",
  status: "At Port",
  transporter: "TransCo",
  agent: "Agent A",
  numberPlate: "T 123",
  trackingLocation: "Dar",
  supplierCode: "SUP1",
  docReceived: true,
  docsReadyNotSent: true,
  daysDelayed: 3,
  isOverdue: true,
  poFreight: "100",
  eta: "2026-03-01",
  trackingDescription: "held at port",
  grandTotal: "1000",
  transportFee: "50",
  dutyFee: "25",
});
const b = row({ containerNumber: "B1", companyName: "beta", shopName: "Shop 2", status: "Arrived", daysDelayed: 0 });
const c = row({
  containerNumber: "C1",
  companyName: "Alpha",
  shopName: "Shop 2",
  status: "In Transit",
  eta: "2026-01-01",
});
const rows = [a, b, c];
const ids = (list: EnrichedContainer[]) => list.map((r) => r.containerNumber);

describe("parseGitPagination", () => {
  it("defaults invalid values and caps the page size", () => {
    expect(parseGitPagination({})).toEqual({ page: 1, pageSize: 50, offset: 0 });
    expect(parseGitPagination({ page: "-1", pageSize: "abc" })).toEqual({ page: 1, pageSize: 50, offset: 0 });
    expect(parseGitPagination({ page: "3", pageSize: "500" })).toEqual({ page: 3, pageSize: 100, offset: 200 });
  });
});

describe("applyGitTableFilters", () => {
  const cases: Array<[Record<string, string | string[]>, string[]]> = [
    [{}, ["A1", "B1", "C1"]],
    [{ company: "ALL" }, ["A1", "B1", "C1"]],
    [{ company: "beta" }, ["B1"]],
    [{ status: "Arrived" }, ["B1"]],
    [{ transporter: "TransCo" }, ["A1"]],
    [{ agent: "Agent A" }, ["A1"]],
    [{ location: "Dar" }, ["A1"]],
    [{ docsReady: "true" }, ["A1"]],
    [{ delayed: "true" }, ["A1"]],
    [{ overdue: "true" }, ["A1"]],
    [{ containers: ["A1", "C1"] }, ["A1", "C1"]],
    [{ suppliers: "SUP1" }, ["A1"]],
    [{ transporters: "NO_TRANSPORTER" }, ["B1", "C1"]],
    [{ transporters: "TransCo" }, ["A1"]],
    [{ agents: "NO_AGENT" }, ["B1", "C1"]],
    [{ trucks: "HAS_TRUCK" }, ["A1"]],
    [{ trucks: "NO_TRUCK" }, ["B1", "C1"]],
    [{ locations: "HAS_LOCATION, NO_LOCATION" }, ["A1", "B1", "C1"]],
    [{ docs: "MISSING" }, ["B1", "C1"]],
    [{ docs: "RECEIVED" }, ["A1"]],
    [{ delayedState: "YES" }, ["A1"]],
    [{ delayedState: "OVERDUE" }, ["A1"]],
    [{ delayedState: "NO" }, ["B1", "C1"]],
    [{ freight: "HAS_FREIGHT" }, ["A1"]],
    [{ freight: "NO_FREIGHT" }, ["B1", "C1"]],
    [{ etaDates: "2026-01-01" }, ["C1"]],
    [{ includeNoEta: "true" }, ["B1"]],
    [{ etaDates: "2026-03-01", includeNoEta: "true" }, ["A1", "B1"]],
    [{ notes: "WITH" }, ["A1"]],
    [{ notes: "WITHOUT" }, ["B1", "C1"]],
    [{ search: "trans" }, ["A1"]],
    [{ q: "beta" }, ["B1"]],
  ];
  it.each(cases)("filters %j", (query, expected) => {
    expect(ids(applyGitTableFilters(rows, query))).toEqual(expected);
  });
});

describe("sortGitRows", () => {
  it("sorts by company, shop and container by default", () => {
    expect(ids(sortGitRows(rows, undefined))).toEqual(["C1", "A1", "B1"]);
    const sameShop = row({ containerNumber: "A0", companyName: "Alpha", shopName: "Shop 2" });
    expect(ids(sortGitRows([c, sameShop], undefined))).toEqual(["A0", "C1"]);
  });

  it("sorts by ETA with missing dates last in both directions", () => {
    expect(ids(sortGitRows(rows, "ETA_ASC"))).toEqual(["C1", "A1", "B1"]);
    expect(ids(sortGitRows(rows, "ETA_DESC"))).toEqual(["A1", "C1", "B1"]);
    const noEta = row({ containerNumber: "Z9", companyName: "Alpha" });
    expect(ids(sortGitRows([noEta, b], "ETA_ASC"))).toEqual(["Z9", "B1"]);
  });
});

describe("facets, summary and compact rows", () => {
  it("builds unique facets and summary totals", () => {
    const facets = buildGitFacets(rows);
    expect(facets.companies).toEqual(["Alpha", "beta"]);
    expect(facets.etaDates).toEqual(["2026-01-01", "2026-03-01"]);
    expect(facets.trucks).toEqual(["T 123"]);
    expect(facets.hasContainersWithNoEta).toBe(true);
    expect(buildGitTableSummary(rows)).toEqual({
      total: 3,
      atSea: 0,
      atPort: 1,
      leftDar: 0,
      inTransit: 1,
      arrived: 1,
      delayed: 1,
      overdue: 1,
      totalCost: 1000,
      totalTransportDuty: 75,
    });
  });

  it("strips tracking internals from compact rows", () => {
    const compact = toGitCompactRow({ ...a, trackingError: "x", createdAt: "now" } as unknown as EnrichedContainer);
    expect(compact).not.toHaveProperty("trackingError");
    expect(compact).not.toHaveProperty("createdAt");
    expect(compact.containerNumber).toBe("A1");
  });
});
