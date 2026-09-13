/**
 * Phase 3 backend coverage — successful report workflows + failure edges.
 *
 * The chat/report implementation is a large backend-only surface that does not
 * require an external AI provider: after intent resolution it is just our own
 * SQL/report formatting code. Exercise every registered report query against a
 * real migrated test database so coverage reaches the actual implementation
 * shards instead of stopping at route discovery.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  findReportImplementation,
  implementedReportQueryTypes,
  runReportImplementation,
} from "../server/chat/reports/implementations/reportImplementationRegistry";
import type { DataQueryContext, ReportQueryParams } from "../server/chat/reports/types";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "phase3rpt";
const TODAY = "2026-09-12";

let ctx: TestContext;

function reportContext(queryType?: string, overrides: ReportQueryParams = {}): DataQueryContext {
  return {
    companyId: ctx.companyId,
    params: {
      queryType,
      // Supplying harmless filters makes the conditional SQL/filter branches
      // execute while remaining deterministic when a domain has no fixture row.
      entityName: "Test",
      locationName: `${TEST_PREFIX}_Warehouse1`,
      containerNumber: `${TEST_PREFIX}-MISSING-CONTAINER`,
      containerStatus: "PENDING",
      ...overrides,
    },
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    todayStr: TODAY,
    todayDate: new Date(`${TODAY}T12:00:00.000Z`),
    thisMonthStart: "2026-09-01",
    lastMonthStart: "2026-08-01",
    lastMonthEnd: "2026-08-31",
    rowLimit: 25,
    userMessage: "backend coverage report workflow",
    fmt: (value) => value.toFixed(2),
    fmtDec: (value) => value.toFixed(2),
  };
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe.sequential("Phase 3 report workflow coverage", () => {
  it("keeps every registered report query mapped to an implementation", () => {
    expect(implementedReportQueryTypes.length).toBe(71);
    expect(new Set(implementedReportQueryTypes).size).toBe(implementedReportQueryTypes.length);

    for (const queryType of implementedReportQueryTypes) {
      expect(findReportImplementation(queryType), queryType).toBeDefined();
    }
  });

  it(
    "executes all 71 successful report workflow implementations against the migrated database",
    async () => {
      const failures: string[] = [];

      for (const queryType of implementedReportQueryTypes) {
        try {
          const result = await runReportImplementation(reportContext(queryType));
          if (!result || result.queryType !== queryType) {
            failures.push(`${queryType}: returned ${JSON.stringify(result)?.slice(0, 180)}`);
          }
        } catch (error) {
          failures.push(`${queryType}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      expect(failures, failures.join("\n")).toEqual([]);
    },
    180000
  );

  it("covers statement success/no-data branches with real fixture ledger accounts", async () => {
    const customerStatement = await runReportImplementation(
      reportContext("customer_statement", { entityName: "Cash Account" })
    );
    expect(customerStatement?.queryType).toBe("customer_statement");
    expect(customerStatement?.title).toContain("Cash Account");

    const supplierStatement = await runReportImplementation(
      reportContext("supplier_statement", { entityName: "Sales Revenue" })
    );
    expect(supplierStatement?.queryType).toBe("supplier_statement");
    expect(supplierStatement?.title).toContain("Sales Revenue");
  });

  it("covers required-input and unknown-query failure paths without throwing", async () => {
    for (const queryType of ["customer_statement", "supplier_statement"] as const) {
      const result = await runReportImplementation(reportContext(queryType, { entityName: undefined }));
      expect(result?.queryType).toBe(queryType);
      expect(String(result?.summary ?? "")).toMatch(/specify/i);
    }

    expect(await runReportImplementation(reportContext("__unknown_report__"))).toBeUndefined();
    expect(await runReportImplementation(reportContext(undefined))).toBeUndefined();
    expect(findReportImplementation("__unknown_report__")).toBeUndefined();
  });
});
