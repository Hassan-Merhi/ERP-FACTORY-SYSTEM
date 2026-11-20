import { describe, expect, it } from "vitest";
import {
  RE_STOCK_TRANSFER_EXPLICIT,
  deterministicParseMultiSourceTransfer,
  detectSmartProvider,
} from "../server/chat/intent";

const LOCATIONS = [
  { id: 1, name: "Kolwezi", code: null },
  { id: 2, name: "Kolwezi 2", code: "K2" },
  { id: 11, name: "Hadi 1", code: null },
  { id: 12, name: "Hadi 2", code: null },
  { id: 13, name: "Hadi 3", code: null },
  { id: 14, name: "Hadi 4", code: null },
  { id: 20, name: "X", code: null },
  { id: 21, name: "", code: null },
  { id: 22, name: null as unknown as string, code: null },
  { id: 30, name: "Lubumbashi", code: null },
];

describe("detectSmartProvider", () => {
  it("routes code generation to chatgpt only when chatgpt is available", () => {
    expect(detectSmartProvider("write a function to sort numbers", ["chatgpt"])).toBe("chatgpt");
    expect(detectSmartProvider("write a function to sort numbers", ["gemini"])).toBeNull();
  });

  it("routes news queries to grok only when grok is available", () => {
    expect(detectSmartProvider("what is the latest news today", ["grok"])).toBe("grok");
    expect(detectSmartProvider("what is the latest news today", ["chatgpt"])).toBeNull();
  });

  it("routes analytical questions to gemini only when gemini is available", () => {
    expect(detectSmartProvider("explain the chemistry of soap", ["gemini"])).toBe("gemini");
    expect(detectSmartProvider("explain the chemistry of soap", ["grok"])).toBeNull();
  });

  it("returns null for plain chat", () => {
    expect(detectSmartProvider("hello there", ["gemini", "grok", "chatgpt"])).toBeNull();
  });
});

describe("RE_STOCK_TRANSFER_EXPLICIT", () => {
  it("accepts a stock transfer and rejects an inventory-account ledger transfer", () => {
    expect(RE_STOCK_TRANSFER_EXPLICIT.test("stock transfer 50 bales to Kolwezi")).toBe(true);
    expect(RE_STOCK_TRANSFER_EXPLICIT.test("transfer $500 from the inventory account to cash")).toBe(false);
    expect(RE_STOCK_TRANSFER_EXPLICIT.test("pay the supplier")).toBe(false);
  });
});

describe("deterministicParseMultiSourceTransfer", () => {
  it("resolves destination and repeated full-name sources, keeping the most specific overlap", () => {
    const r = deterministicParseMultiSourceTransfer(
      "Create an optional transfer of 410 bales to Kolwezi 2 from Hadi 1, Hadi 2, Hadi 3",
      LOCATIONS
    );
    expect(r).toEqual({
      destinationName: "Kolwezi 2",
      sourceNames: ["Hadi 1", "Hadi 2", "Hadi 3"],
      targetQty: 410,
      optional: true,
    });
  });

  it("expands comma shorthand sources when only one named source matches", () => {
    const r = deterministicParseMultiSourceTransfer("410 bales to Kolwezi from Hadi 1,2,3,and 4 today", LOCATIONS);
    expect(r?.destinationName).toBe("Kolwezi");
    expect(r?.sourceNames).toEqual(["Hadi 1", "Hadi 2", "Hadi 3", "Hadi 4"]);
    expect(r?.optional).toBe(false);
  });

  it("expands range shorthand sources and ignores unknown expanded names", () => {
    const r = deterministicParseMultiSourceTransfer("send 100 units to Kolwezi from Hadi 3-6", LOCATIONS);
    expect(r?.sourceNames).toEqual(["Hadi 3", "Hadi 4"]);
  });

  it("does not expand reversed or oversized ranges", () => {
    expect(deterministicParseMultiSourceTransfer("send 100 units to Kolwezi from Hadi 9-1", LOCATIONS)).toBeNull();
    expect(deterministicParseMultiSourceTransfer("send 100 units to Kolwezi from Hadi 9-70", LOCATIONS)).toBeNull();
  });

  it("drops excluded locations from the source list", () => {
    const r = deterministicParseMultiSourceTransfer(
      "50 bags to Lubumbashi from Hadi 1, Hadi 2, Hadi 3. do not use Hadi 2.",
      LOCATIONS
    );
    expect(r?.sourceNames).toEqual(["Hadi 1", "Hadi 3"]);
  });

  it("keeps a single named source when the shorthand segment is not a list", () => {
    const r = deterministicParseMultiSourceTransfer("20 pcs to Kolwezi from Hadi 1 only same group", LOCATIONS);
    expect(r?.sourceNames).toEqual(["Hadi 1"]);
  });

  it("returns null when there is no 'from' clause", () => {
    expect(deterministicParseMultiSourceTransfer("410 bales to Kolwezi", LOCATIONS)).toBeNull();
  });

  it("returns null when the from segment is empty after trimming today", () => {
    expect(deterministicParseMultiSourceTransfer("410 bales to Kolwezi from today", LOCATIONS)).toBeNull();
  });

  it("returns null without a quantity", () => {
    expect(deterministicParseMultiSourceTransfer("move stock to Kolwezi from Hadi 1, Hadi 2", LOCATIONS)).toBeNull();
  });

  it("returns null for a zero quantity", () => {
    expect(deterministicParseMultiSourceTransfer("0 bales to Kolwezi from Hadi 1, Hadi 2", LOCATIONS)).toBeNull();
  });

  it("returns null when two destinations appear before 'from'", () => {
    expect(
      deterministicParseMultiSourceTransfer("10 bales to Kolwezi and Lubumbashi from Hadi 1, Hadi 2", LOCATIONS)
    ).toBeNull();
  });

  it("returns null when no sources resolve", () => {
    expect(deterministicParseMultiSourceTransfer("10 bales to Kolwezi from Nowhere", LOCATIONS)).toBeNull();
  });
});
