import { describe, expect, it } from "vitest";
import { READ_MICROCACHE_PATHS, READ_MICROCACHE_TTL_MS } from "./readMicrocache";

describe("Wave 6 realtime read freshness", () => {
  it("does not microcache ERP employees because the payload carries live payroll/journal balances", () => {
    expect(READ_MICROCACHE_PATHS.has("/api/employees")).toBe(false);
    expect(READ_MICROCACHE_TTL_MS.has("/api/employees")).toBe(false);
  });

  it("keeps true payroll selector reference data cached", () => {
    expect(READ_MICROCACHE_PATHS.has("/api/payroll/bonus-locations")).toBe(true);
    expect(READ_MICROCACHE_TTL_MS.get("/api/payroll/bonus-locations")).toBe(300_000);
  });
});
