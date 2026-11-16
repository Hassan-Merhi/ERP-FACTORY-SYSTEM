import { describe, expect, it } from "vitest";
import {
  getSchedulerCallbackName,
  nameSchedulerCallback,
  resolveSchedulerMetricName,
} from "../server/lib/schedulerObservability";
import { parseBoundedPagination, wantsBoundedPagination } from "../server/lib/boundedPagination";
import { loadOverdueCustomerBalances } from "../server/services/scheduler/overdueCustomerQuery";

describe("Phase 5 performance and operations", () => {
  it("records cron metrics under a stable business job name", () => {
    const callback = nameSchedulerCallback(async () => undefined, "overdue customer check");

    expect(getSchedulerCallbackName(callback)).toBe("overdue-customer-check");
    expect(resolveSchedulerMetricName("0 9 * * *", callback)).toBe("cron:overdue-customer-check");
    expect(resolveSchedulerMetricName("0 9 * * *", async () => undefined)).toBe("cron-expression:0 9 * * *");
  });

  it("executes the overdue-customer balance query against the current schema", async () => {
    const rows = await loadOverdueCustomerBalances();

    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(Number.isInteger(row.id)).toBe(true);
      expect(Number.isInteger(row.company_id)).toBe(true);
      expect(Number.isFinite(Number(row.net_balance))).toBe(true);
    }
  });

  it("keeps account-transfer pagination bounded while preserving legacy opt-in", () => {
    expect(wantsBoundedPagination({})).toBe(false);
    expect(wantsBoundedPagination({ pagination: "1" })).toBe(true);
    expect(wantsBoundedPagination({ page: "3" })).toBe(true);

    expect(parseBoundedPagination({ page: "3", pageSize: "100" })).toEqual({ page: 3, limit: 100, offset: 200 });
    expect(parseBoundedPagination({ offset: "550", limit: "5000" }, { defaultLimit: 100, maxLimit: 250 })).toEqual({
      page: 3,
      limit: 250,
      offset: 550,
    });
  });
});
