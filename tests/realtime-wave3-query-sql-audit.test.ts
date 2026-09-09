import { describe, expect, it } from "vitest";

// @ts-expect-error - repository audit is intentionally plain ESM so it can also
// run directly with Node outside Vitest.
import { auditRealtimeWave3 } from "../scripts/audit-realtime-wave3.mjs";

describe("Realtime Refresh Wave 3 certification", () => {
  it("keeps Phase 5 query surfaces off staleTime zero", () => {
    const result = auditRealtimeWave3();
    expect(result.phase5Targets).toHaveLength(10);
    expect(result.errors.filter((error: string) => error.includes("staleTime: 0"))).toEqual([]);
  });

  it("keeps the reviewed non-zero freshness policies and mutation-driven architecture intact", () => {
    const result = auditRealtimeWave3();
    expect(result.errors.filter((error: string) => error.includes("freshness policy"))).toEqual([]);
  });

  it("keeps Phase 6 net-position balances aggregated in PostgreSQL", () => {
    const result = auditRealtimeWave3();
    expect(result.phase6Target).toBe("server/helpers/calculateNetPositionAsOf.ts");
    expect(result.errors.filter((error: string) => error.includes("SQL aggregation contract"))).toEqual([]);
    expect(result.errors.filter((error: string) => error.includes("legacy full-entry Node aggregation"))).toEqual([]);
  });

  it("passes the complete Wave 3 contract", () => {
    const result = auditRealtimeWave3();
    expect(result).toMatchObject({ ok: true, errors: [] });
  });
});
