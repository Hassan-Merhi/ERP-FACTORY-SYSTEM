import { describe, expect, it } from "vitest";
import { posDaybookEditEligibility } from "../shared/posDaybookEditPolicy";

const base = {
  originalDate: "2026-11-17",
  businessDate: "2026-11-18",
  editDays: 2,
  isOwnSale: true,
};

describe("Zambia POS Daybook edit authorization", () => {
  it("permits an own shift's sale from yesterday when enabled for two days", () => {
    expect(posDaybookEditEligibility(base)).toEqual({ allowed: true, reason: "enabled" });
    expect(posDaybookEditEligibility({ ...base, originalDate: "2026-11-16" }).allowed).toBe(true);
  });

  it("blocks disabled permissions including today's own sale", () => {
    expect(posDaybookEditEligibility({ ...base, originalDate: "2026-11-18", editDays: 0 }))
      .toMatchObject({ allowed: false, reason: "disabled" });
  });

  it("blocks other cashiers' sales and view-only cashiers", () => {
    expect(posDaybookEditEligibility({ ...base, isOwnSale: false }).reason).toBe("not-owner");
    expect(posDaybookEditEligibility({ ...base, viewOnly: true }).reason).toBe("view-only");
  });

  it("blocks sales older than the configured window, but never changes their dates", () => {
    expect(posDaybookEditEligibility({ ...base, originalDate: "2026-11-15" }).reason).toBe("outside-window");
    expect(posDaybookEditEligibility({ ...base, originalDate: "2026-11-19" }).reason).toBe("future-date");
  });

  it("uses calendar dates, including leap day and month boundaries", () => {
    expect(posDaybookEditEligibility({
      ...base, businessDate: "2024-03-01", originalDate: "2024-02-29", editDays: 1,
    }).allowed).toBe(true);
    expect(posDaybookEditEligibility({
      ...base, businessDate: "2026-03-01", originalDate: "2026-02-29",
    }).reason).toBe("invalid-date");
  });

  it("rejects malformed business dates and non-integer day-window configuration", () => {
    expect(posDaybookEditEligibility({ ...base, businessDate: "yesterday" }).reason).toBe("invalid-date");
    expect(posDaybookEditEligibility({ ...base, editDays: -2 }).allowed).toBe(false);
    expect(posDaybookEditEligibility({ ...base, editDays: 1.5 }).allowed).toBe(false);
  });
});
