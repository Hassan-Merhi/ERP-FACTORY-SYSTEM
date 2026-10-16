import { describe, expect, it } from "vitest";
import { FRESH_START_OTW_SOURCE_NAME, isGoldenCoastOtwSource } from "./goldenCoastOtwSource";

describe("Fresh Start FZE supplier-free Goods OTW policy", () => {
  it("uses Fresh Start as an internal source with both GC ownership roles", () => {
    expect(isGoldenCoastOtwSource([
      { subType: "gc_partner_capital" },
      { subType: "gc_owner_capital" },
      { subType: "sp_goods_otw" },
    ])).toBe(true);
    expect(FRESH_START_OTW_SOURCE_NAME).toBe("Fresh Start FZE");
  });

  it("never applies to normal supplier partners or partial GC setup", () => {
    expect(isGoldenCoastOtwSource([{ subType: "sp_goods_otw" }])).toBe(false);
    expect(isGoldenCoastOtwSource([{ subType: "gc_partner_capital" }])).toBe(false);
    expect(isGoldenCoastOtwSource([{ subType: "gc_owner_capital" }])).toBe(false);
  });
});
