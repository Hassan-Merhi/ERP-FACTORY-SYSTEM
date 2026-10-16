import { describe, expect, it } from "vitest";
import { daysSincePortDeparture } from "../client/src/pages/pos/portDeparture";

describe("POS container days since leaving port", () => {
  it("counts departure day as zero and increases each calendar day", () => {
    expect(daysSincePortDeparture("2026-10-16", "2026-10-16")).toBe(0);
    expect(daysSincePortDeparture("2026-10-11", "2026-10-16")).toBe(5);
  });

  it("handles leap days without relying on local clock hours", () => {
    expect(daysSincePortDeparture("2024-02-28", "2024-03-01")).toBe(2);
  });

  it("keeps missing, impossible and future dates blank", () => {
    expect(daysSincePortDeparture(null, "2026-10-16")).toBeNull();
    expect(daysSincePortDeparture("2026-02-30", "2026-10-16")).toBeNull();
    expect(daysSincePortDeparture("2026-10-17", "2026-10-16")).toBeNull();
  });
});
