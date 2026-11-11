import { describe, expect, it } from "vitest";
import { FEATURE_KEYS } from "../shared/schema/common";
import { ERP_HIDDEN_COST_FIELD_KEYS, parseErpHiddenCostFields, parseErpPageGrantKeys } from "../shared/erpPageGrantInput";

describe("ERP page grant input validation", () => {
  it("accepts an empty grant list as an explicit, valid revoke", () => {
    expect(parseErpPageGrantKeys([])).toEqual([]);
  });

  it("accepts the known ERP feature keys without transforming their order", () => {
    expect(parseErpPageGrantKeys(["accounts", "pos", "daybook"])).toEqual(["accounts", "pos", "daybook"]);
    expect(parseErpPageGrantKeys([...FEATURE_KEYS])).toEqual([...FEATURE_KEYS]);
  });

  it("fails closed on unrecognized, repeated, mixed-type or malformed input", () => {
    for (const invalid of [
      undefined, null, "", {}, ["accounts", "accounts"],
      ["accounts", "admin-override"], ["accounts", null], [3], "accounts",
    ]) {
      expect(parseErpPageGrantKeys(invalid)).toBeNull();
    }
  });

  it("rejects values that could otherwise be interpreted as a partial list", () => {
    expect(parseErpPageGrantKeys(["accounts", ""])).toBeNull();
    expect(parseErpPageGrantKeys(["accounts", "Accounts"])).toBeNull();
    expect(parseErpPageGrantKeys(["accounts", { pageKey: "pos" }])).toBeNull();
  });
});

describe("ERP hidden-cost restriction input validation", () => {
  it("preserves all recognized legacy and current hidden-cost flags", () => {
    expect(parseErpHiddenCostFields([...ERP_HIDDEN_COST_FIELD_KEYS])).toEqual([...ERP_HIDDEN_COST_FIELD_KEYS]);
    expect(ERP_HIDDEN_COST_FIELD_KEYS).toContain("stock_rates");
    expect(ERP_HIDDEN_COST_FIELD_KEYS).toContain("hide_export_cost_price");
  });

  it("rejects malformed, unknown and duplicate restriction keys", () => {
    for (const invalid of [
      undefined, null, ["stock_rates", "stock_rates"], ["stock_rates", "unknown_flag"],
      [null], ["sales_profit_cost", 1], "stock_rates",
    ]) {
      expect(parseErpHiddenCostFields(invalid)).toBeNull();
    }
    expect(parseErpHiddenCostFields([])).toEqual([]);
  });
});
