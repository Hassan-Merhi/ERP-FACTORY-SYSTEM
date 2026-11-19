/**
 * Chat stock-transfer draft builder: the LLM-parsed multi-source branch and
 * every refusal it can answer (no destination, ambiguous or unknown
 * destination, no sources, no quantity, unknown sources, sources equal to the
 * destination, no stock), the analysis and plain extraction branches, and the
 * anti-hallucination fallback. The LLM, location matcher, allocation context
 * and database are mocked at the module boundary (same harness as
 * phase33-3c-stock-transfer-drafts.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../server/chat/aiProviders";

const h = vi.hoisted(() => {
  const state = { selectResults: [] as unknown[][] };
  const select = vi.fn(() => {
    const result = state.selectResults.shift() ?? [];
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });
  return {
    state,
    db: { select, execute: vi.fn() },
    callAI: vi.fn(),
    deterministic: vi.fn(),
    suggestion: vi.fn(),
    byTarget: vi.fn(),
    match: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: h.db }));
vi.mock("../server/chat/aiProviders", () => ({ callAIWithFallback: h.callAI }));
vi.mock("../server/chat/intent", () => ({
  deterministicParseMultiSourceTransfer: h.deterministic,
  RE_MULTI_SOURCE_LOCATIONS: /\b[a-z][a-z\s]*\d+\s*(?:,\s*\d+)+\b|\b[a-z][a-z\s]*\d+\s*-\s*\d+\b/i,
  RE_STOCK_GROUP_FILTER_HINT: /same stock group|same groups/i,
  RE_STOCK_TRANSFER: /transfer/i,
  RE_STOCK_TRANSFER_ANALYSIS: /suggest|analy[sz]e/i,
  RE_STOCK_TRANSFER_ANALYSIS_STRICT: /strict-analysis/i,
  RE_TARGET_QTY_HINT: /\b\d+\s*(?:bales?|items?|units?)\b/i,
}));
vi.mock("../server/services/stockTransferAnalysis", () => ({
  buildStockTransferSuggestionContext: h.suggestion,
  buildStockTransferByTargetQuantityContext: h.byTarget,
  matchLocationByName: h.match,
}));

import { buildStockTransferDrafts } from "../server/chat/stockTransferDrafts";

const HADI1 = { id: 1, name: "Hadi 1", code: "H1" };
const HADI2 = { id: 2, name: "Hadi 2", code: "H2" };
const KOL = { id: 9, name: "Kolwezi", code: "KLZ" };
const MULTI = "transfer to Kolwezi from Hadi 1, 2";
const FALLBACK = "I wasn't able to build a stock transfer draft";

const run = (userMessage: string) =>
  buildStockTransferDrafts({
    userMessage,
    companyId: 7,
    selectedProvider: "openai" as AIProvider,
    voucherDraft: null,
    stockAdjustmentDraft: null,
  });

const llmSays = (value: unknown) =>
  h.callAI.mockResolvedValueOnce({
    response: typeof value === "string" ? value : "```json\n" + JSON.stringify(value) + "\n```",
  });
const matches = (...results: Array<{ matched: unknown; candidates?: unknown[] }>) => {
  for (const r of results) h.match.mockResolvedValueOnce({ candidates: [], ...r });
};
const parsed = (overrides: Record<string, unknown> = {}) => ({
  destinationLocationName: "Kolwezi",
  sourceLocationNames: ["Hadi 1", "Hadi 2"],
  targetQty: 12,
  optional: false,
  date: "2026-03-04",
  onlyDestinationStockGroups: true,
  ...overrides,
});
const draft = (source: typeof HADI1, qty: number) => ({
  sourceLocationId: source.id,
  sourceLocationName: source.name,
  destinationLocationId: KOL.id,
  destinationLocationName: KOL.name,
  items: [{ stockItemId: 5, stockItemName: "Bale", stockItemCode: "B", quantity: qty, currentStock: 30, reason: "r" }],
});

beforeEach(() => {
  vi.clearAllMocks();
  h.callAI.mockReset();
  h.match.mockReset();
  h.state.selectResults.splice(0);
  h.state.selectResults.push([HADI1, HADI2, KOL]);
  h.deterministic.mockReturnValue(null);
});

describe("multi-source transfer parsed by the LLM: refusals", () => {
  it("asks to restate when the LLM cannot parse the request", async () => {
    llmSays("null");
    const result = await run(MULTI);
    expect(result.stockTransferResponseOverride).toContain("I couldn't tell which destination");
    expect(h.match).not.toHaveBeenCalled();
  });

  it("asks for a destination when none was named", async () => {
    llmSays(parsed({ destinationLocationName: "", sourceLocationNames: "Hadi 1" }));
    matches({ matched: null });
    const result = await run(MULTI);
    expect(result.stockTransferResponseOverride).toContain("I need a destination location");
    expect(h.byTarget).not.toHaveBeenCalled();
  });

  it("lists candidates for an ambiguous destination without building a draft", async () => {
    llmSays(parsed());
    matches({ matched: null, candidates: [KOL, { id: 10, name: "Kolwezi 2", code: "K2" }] });
    const result = await run(MULTI);
    expect(result.stockTransferDraft).toMatchObject({
      date: "2026-03-04",
      sourceLocationName: "Hadi 1, Hadi 2",
      items: [],
      locationCandidates: [
        { id: 9, name: "Kolwezi (KLZ)" },
        { id: 10, name: "Kolwezi 2 (K2)" },
      ],
    });
    expect(result.stockTransferResponseOverride).toContain('"Kolwezi" matches more than one location');
    expect(h.match).toHaveBeenCalledWith(7, "Kolwezi", { strict: true });
  });

  it("refuses an unknown destination, missing sources and a missing quantity", async () => {
    llmSays(parsed({ destinationLocationName: "Nowhere" }));
    matches({ matched: null });
    expect((await run(MULTI)).stockTransferResponseOverride).toContain(`couldn't find a location matching "Nowhere"`);

    h.state.selectResults.push([KOL]);
    llmSays(parsed({ sourceLocationNames: ["", 4] }));
    matches({ matched: KOL });
    expect((await run(MULTI)).stockTransferResponseOverride).toBe(
      "Which source location(s) should I pull stock from for the transfer to Kolwezi?"
    );

    h.state.selectResults.push([KOL]);
    llmSays(parsed({ targetQty: -3 }));
    matches({ matched: KOL });
    expect((await run(MULTI)).stockTransferResponseOverride).toBe(
      "How many bales/items in total would you like transferred to Kolwezi?"
    );
    expect(h.byTarget).not.toHaveBeenCalled();
  });

  it("refuses when no source matches, and when every source is the destination", async () => {
    llmSays(parsed());
    matches({ matched: KOL }, { matched: null }, { matched: null });
    expect((await run(MULTI)).stockTransferResponseOverride).toContain(
      "I couldn't find any of the source locations you mentioned (Hadi 1, Hadi 2)"
    );

    h.state.selectResults.push([KOL]);
    llmSays(parsed({ sourceLocationNames: ["Kolwezi"] }));
    matches({ matched: KOL }, { matched: KOL });
    expect((await run(MULTI)).stockTransferResponseOverride).toContain("are the same as the destination (Kolwezi)");
    expect(h.byTarget).not.toHaveBeenCalled();
  });

  it("reports no stock at all when stock-group filtering is off", async () => {
    llmSays(parsed({ onlyDestinationStockGroups: false, date: undefined }));
    matches({ matched: KOL }, { matched: HADI1 }, { matched: null });
    h.byTarget.mockResolvedValueOnce({ noEligibleStock: true, drafts: [] });
    const result = await run(MULTI);
    expect(h.byTarget).toHaveBeenCalledWith(7, [1], 9, 12, { onlyDestinationStockGroups: false });
    expect(result.stockTransferResponseOverride).toBe(
      "I didn't find any stock available at Hadi 1 (couldn't find: Hadi 2), so I did not create a transfer draft."
    );
    expect(result.stockTransferDraft).toBeUndefined();
  });
});

describe("multi-source transfer parsed by the LLM: drafts", () => {
  it("builds one draft per source and an optional summary when the quantity is met", async () => {
    llmSays(parsed({ optional: true, targetQty: "12.7" }));
    matches({ matched: KOL }, { matched: HADI1 }, { matched: HADI2 });
    h.byTarget.mockResolvedValueOnce({
      noEligibleStock: false,
      shortfall: false,
      achievedQty: 12,
      drafts: [draft(HADI1, 7), draft(HADI2, 5)],
    });
    const result = await run(MULTI);
    expect(result.stockTransferDraft).toBeUndefined();
    expect(result.stockTransferDrafts).toHaveLength(2);
    expect(result.stockTransferDrafts?.[0]).toMatchObject({
      optional: true,
      analysisSummary: undefined,
      notes: "Auto-selected using stock groups already carried at Kolwezi.",
      items: [{ stockItemId: 5, quantity: 7 }],
    });
    expect(result.stockTransferResponseOverride).toBe(
      "I prepared an optional stock transfer drafts for 12 bale(s)/item(s) from Hadi 1/Hadi 2 to Kolwezi. Review below."
    );
  });

  it("builds a single draft and notes unresolved sources", async () => {
    llmSays(parsed({ onlyDestinationStockGroups: false }));
    matches({ matched: KOL }, { matched: HADI1 }, { matched: null });
    h.byTarget.mockResolvedValueOnce({
      noEligibleStock: false,
      shortfall: false,
      achievedQty: 12,
      drafts: [draft(HADI1, 12)],
    });
    const result = await run(MULTI);
    expect(result.stockTransferDraft).toMatchObject({
      notes: undefined,
      analysisSummary: "Note: (couldn't find: Hadi 2).",
    });
    expect(result.stockTransferResponseOverride).toBe(
      "I prepared stock transfer draft for 12 bale(s)/item(s) from Hadi 1 to Kolwezi (couldn't find: Hadi 2). Review below."
    );
  });

  it("reports a shortfall for a non-optional deterministic request", async () => {
    h.deterministic.mockReturnValue({
      destinationName: "Kolwezi",
      sourceNames: ["Hadi 1"],
      targetQty: 20,
      optional: false,
    });
    matches({ matched: KOL }, { matched: HADI1 });
    h.byTarget.mockResolvedValueOnce({
      noEligibleStock: false,
      shortfall: true,
      achievedQty: 8,
      drafts: [draft(HADI1, 8)],
    });
    const result = await run(MULTI);
    expect(h.callAI).not.toHaveBeenCalled();
    expect(result.stockTransferResponseOverride).toBe(
      "Only 8 eligible bale(s)/item(s) found out of requested 20. I prepared stock transfer draft for Kolwezi using the available eligible stock from Hadi 1. Review below."
    );
  });
});

describe("analysis and plain extraction branches", () => {
  it("falls back when the analysis parser returns null or the source is ambiguous", async () => {
    llmSays("null");
    expect((await run("suggest a transfer")).stockTransferResponseOverride).toContain(FALLBACK);

    h.state.selectResults.push([]);
    llmSays({ sourceLocationName: "Hadi", destinationLocationName: "Kolwezi" });
    matches({ matched: null, candidates: [HADI1, HADI2] }, { matched: KOL });
    const ambiguous = await run("suggest a transfer");
    expect(ambiguous.stockTransferDraft).toMatchObject({
      sourceLocationId: 0,
      sourceLocationName: "Hadi",
      destinationLocationId: 9,
      locationCandidates: [
        { id: 1, name: "Hadi 1 (H1)" },
        { id: 2, name: "Hadi 2 (H2)" },
      ],
    });
    expect(ambiguous.stockTransferResponseOverride).toContain("Multiple locations matched");
  });

  it("defaults the analysis window and aggressiveness, and falls back when a location is unknown", async () => {
    llmSays({ sourceLocationName: "Hadi 1", destinationLocationName: "Kolwezi", days: "x", aggressiveness: "wild" });
    matches({ matched: HADI1 }, { matched: KOL });
    h.suggestion.mockResolvedValueOnce({
      sourceLocationId: 1,
      sourceLocationName: "Hadi 1",
      destinationLocationId: 9,
      destinationLocationName: "Kolwezi",
      dateFrom: "a",
      dateTo: "b",
      aggressiveness: "normal",
      items: [{ stockItemId: 5, suggestedQty: 3, sourceQty: 10, lastTransferDate: null }],
    });
    const result = await run("analyze a transfer");
    const [, , , dateFrom, dateTo, options] = h.suggestion.mock.calls[0];
    expect(options).toEqual({ aggressiveness: "normal" });
    expect((Date.parse(dateTo) - Date.parse(dateFrom)) / 86_400_000).toBe(29);
    expect(result.stockTransferDraft?.items?.[0]).toMatchObject({ quantity: 3, lastTransferDate: undefined });
    expect(result.stockTransferResponseOverride).toBeUndefined();

    h.state.selectResults.push([]);
    llmSays({});
    matches({ matched: null }, { matched: KOL });
    expect((await run("analyze a transfer")).stockTransferResponseOverride).toContain(FALLBACK);
  });

  it("enriches a plain extracted transfer with current stock from the source location", async () => {
    h.state.selectResults.splice(0);
    h.state.selectResults.push([{ id: 5, name: "Bale", code: "B" }], [HADI1, KOL]);
    llmSays({
      date: "2026-02-01",
      sourceLocationId: 1,
      destinationLocationId: 9,
      items: [{ stockItemId: 5, quantity: 2 }, { quantity: 1 }],
    });
    h.db.execute.mockResolvedValueOnce({ rows: [{ qty: "14.5" }] });
    const result = await run("transfer 2 Bale from Hadi 1 to Kolwezi");
    expect(h.db.execute).toHaveBeenCalledTimes(1);
    expect(result.stockTransferDraft?.items?.[0].currentStock).toBe(14.5);
    expect(result.stockTransferDraft?.items?.[1]?.currentStock).toBeUndefined();
    expect(result.stockTransferResponseOverride).toBeUndefined();
  });

  it("never claims a draft when the extracted transfer is incomplete or not a transfer", async () => {
    h.state.selectResults.splice(0);
    llmSays({ sourceLocationId: 1, destinationLocationId: 9, items: [] });
    expect((await run("transfer stuff")).stockTransferResponseOverride).toContain(FALLBACK);
    llmSays("null");
    expect((await run("transfer stuff")).stockTransferResponseOverride).toContain(FALLBACK);
    llmSays("{not json");
    expect((await run("transfer stuff")).stockTransferResponseOverride).toContain(FALLBACK);
    expect(h.db.execute).not.toHaveBeenCalled();
  });

  it("ignores messages without transfer intent and strict analysis requests outside the multi-source path", async () => {
    expect(await run("hello there")).toEqual({
      stockTransferDraft: undefined,
      stockTransferDrafts: undefined,
      stockTransferResponseOverride: undefined,
    });
    h.state.selectResults.splice(0);
    llmSays("null");
    const strict = await run("strict-analysis transfer from Hadi 1, 2");
    expect(h.deterministic).not.toHaveBeenCalled();
    expect(strict.stockTransferResponseOverride).toContain(FALLBACK);
  });
});
