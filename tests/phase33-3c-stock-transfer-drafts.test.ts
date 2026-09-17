import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../server/chat/aiProviders";

const harness = vi.hoisted(() => {
  const state = { selectResults: [] as unknown[][] };
  const callAIWithFallback = vi.fn();
  const deterministicParseMultiSourceTransfer = vi.fn();
  const buildStockTransferSuggestionContext = vi.fn();
  const buildStockTransferByTargetQuantityContext = vi.fn();
  const matchLocationByName = vi.fn();

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
    db: { select },
    callAIWithFallback,
    deterministicParseMultiSourceTransfer,
    buildStockTransferSuggestionContext,
    buildStockTransferByTargetQuantityContext,
    matchLocationByName,
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/chat/aiProviders", () => ({
  callAIWithFallback: harness.callAIWithFallback,
}));
vi.mock("../server/chat/intent", () => ({
  deterministicParseMultiSourceTransfer: harness.deterministicParseMultiSourceTransfer,
  // Mirrors server/chat/intent.ts: a multi-source request needs an actual
  // comma- or dash-separated location list ("Hadi 1, 2, 3"). Matching a bare
  // "Hadi 1" would route every analysis message down the deterministic
  // multi-source branch and never reach the path these tests exercise.
  RE_MULTI_SOURCE_LOCATIONS: /\b[a-z][a-z\s]*\d+\s*(?:,\s*\d+)+\b|\b[a-z][a-z\s]*\d+\s*-\s*\d+\b/i,
  RE_STOCK_GROUP_FILTER_HINT: /same stock group|same groups/i,
  RE_STOCK_TRANSFER: /transfer/i,
  RE_STOCK_TRANSFER_ANALYSIS: /suggest|analy[sz]e/i,
  RE_STOCK_TRANSFER_ANALYSIS_STRICT: /strict-analysis/i,
  RE_TARGET_QTY_HINT: /\b\d+\s*(?:bales?|items?|units?)\b/i,
}));
vi.mock("../server/services/stockTransferAnalysis", () => ({
  buildStockTransferSuggestionContext: harness.buildStockTransferSuggestionContext,
  buildStockTransferByTargetQuantityContext: harness.buildStockTransferByTargetQuantityContext,
  matchLocationByName: harness.matchLocationByName,
}));

import { buildStockTransferDrafts } from "../server/chat/stockTransferDrafts";

const provider = "openai" as AIProvider;
const locations = [
  { id: 1, name: "Hadi 1", code: "H1" },
  { id: 9, name: "Kolwezi", code: "KLZ" },
];

function run(userMessage: string, voucherDraft: unknown = null) {
  return buildStockTransferDrafts({
    userMessage,
    companyId: 7,
    selectedProvider: provider,
    voucherDraft,
    stockAdjustmentDraft: null,
  });
}

describe("Phase 33 3C stock-transfer draft builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.selectResults.splice(0);
    harness.deterministicParseMultiSourceTransfer.mockReturnValue(null);
  });

  it("does not create a competing transfer when another draft already exists", async () => {
    const result = await run("transfer stock from Hadi 1 to Kolwezi", { type: "journal" });

    expect(result).toEqual({
      stockTransferDraft: undefined,
      stockTransferDrafts: undefined,
      stockTransferResponseOverride: undefined,
    });
    expect(harness.db.select).not.toHaveBeenCalled();
    expect(harness.callAIWithFallback).not.toHaveBeenCalled();
  });

  it("surfaces ambiguous analysis locations instead of silently choosing one", async () => {
    harness.state.selectResults.push(locations);
    harness.callAIWithFallback.mockResolvedValue({
      response: JSON.stringify({
        sourceLocationName: "Hadi 1",
        destinationLocationName: "Kolwezi",
        days: 30,
        aggressiveness: "normal",
      }),
    });
    harness.matchLocationByName
      .mockResolvedValueOnce({ matched: locations[0], candidates: [] })
      .mockResolvedValueOnce({
        matched: null,
        candidates: [
          { id: 9, name: "Kolwezi", code: "KLZ" },
          { id: 10, name: "Kolwezi 2", code: "KLZ2" },
        ],
      });

    const result = await run("suggest a transfer from Hadi 1 to Kolwezi");

    expect(result.stockTransferDraft).toMatchObject({
      sourceLocationId: 1,
      destinationLocationId: 0,
      items: [],
      locationCandidates: [
        { id: 9, name: "Kolwezi (KLZ)" },
        { id: 10, name: "Kolwezi 2 (KLZ2)" },
      ],
    });
    expect(result.stockTransferResponseOverride).toContain("Multiple locations matched");
    expect(harness.buildStockTransferSuggestionContext).not.toHaveBeenCalled();
  });

  it("uses backend-computed quantities for an analysis draft", async () => {
    harness.state.selectResults.push(locations);
    harness.callAIWithFallback.mockResolvedValue({
      response: JSON.stringify({
        sourceLocationName: "Hadi 1",
        destinationLocationName: "Kolwezi",
        days: 30,
        aggressiveness: "aggressive",
      }),
    });
    harness.matchLocationByName
      .mockResolvedValueOnce({ matched: locations[0], candidates: [] })
      .mockResolvedValueOnce({ matched: locations[1], candidates: [] });
    harness.buildStockTransferSuggestionContext.mockResolvedValue({
      sourceLocationId: 1,
      sourceLocationName: "Hadi 1",
      destinationLocationId: 9,
      destinationLocationName: "Kolwezi",
      dateFrom: "2026-08-19",
      dateTo: "2026-09-17",
      aggressiveness: "aggressive",
      analysisSummary: "Backend analysis",
      oldTransferSummary: "Prior transfer",
      items: [
        {
          stockItemId: 501,
          stockItemName: "Blue Bale",
          stockItemCode: "B-2",
          sourceQty: 40,
          destinationQty: 5,
          sourceSalesQty: 2,
          destinationSalesQty: 12,
          sourceSalesRate: 0.1,
          destinationSalesRate: 0.6,
          otwQty: 3,
          suggestedQty: 11,
          reason: "backend reason",
          confidence: 0.9,
          previousTransferQty: 4,
          previousTransferCount: 1,
          lastTransferDate: "2026-09-01",
          oldTransferSummary: "one prior transfer",
        },
      ],
    });

    const result = await run("analyze and suggest a transfer from Hadi 1 to Kolwezi");

    expect(result.stockTransferDraft).toMatchObject({
      sourceLocationId: 1,
      destinationLocationId: 9,
      items: [
        expect.objectContaining({
          stockItemId: 501,
          quantity: 11,
          suggestedQty: 11,
          reason: "backend reason",
        }),
      ],
    });
  });

  it("excludes the destination from multi-source allocation and reports shortfall", async () => {
    harness.state.selectResults.push(locations);
    harness.deterministicParseMultiSourceTransfer.mockReturnValue({
      destinationName: "Kolwezi",
      sourceNames: ["Hadi 1", "Kolwezi", "Missing Source"],
      targetQty: 10,
      optional: true,
    });
    harness.matchLocationByName
      .mockResolvedValueOnce({ matched: locations[1], candidates: [] })
      .mockResolvedValueOnce({ matched: locations[0], candidates: [] })
      .mockResolvedValueOnce({ matched: locations[1], candidates: [] })
      .mockResolvedValueOnce({ matched: null, candidates: [] });
    harness.buildStockTransferByTargetQuantityContext.mockResolvedValue({
      destinationLocationId: 9,
      destinationLocationName: "Kolwezi",
      targetQty: 10,
      achievedQty: 8,
      shortfall: true,
      noEligibleStock: false,
      drafts: [
        {
          sourceLocationId: 1,
          sourceLocationName: "Hadi 1",
          destinationLocationId: 9,
          destinationLocationName: "Kolwezi",
          totalQty: 8,
          items: [
            {
              stockItemId: 501,
              stockItemName: "Blue Bale",
              stockItemCode: "B-2",
              quantity: 8,
              currentStock: 20,
              stockGroupId: 4,
              stockGroupName: "Blue",
              reason: "available stock",
            },
          ],
        },
      ],
    });

    const result = await run(
      "optional transfer 10 bales to Kolwezi from Hadi 1, Kolwezi, Missing Source same stock group"
    );

    expect(harness.buildStockTransferByTargetQuantityContext).toHaveBeenCalledWith(7, [1], 9, 10, {
      onlyDestinationStockGroups: true,
    });
    expect(result.stockTransferResponseOverride).toContain(
      "Only 8 eligible bale(s)/item(s) found out of requested 10"
    );
    expect(result.stockTransferResponseOverride).toContain("couldn't find: Missing Source");
  });

  it("never claims a transfer draft exists when allocation finds no eligible stock", async () => {
    harness.state.selectResults.push(locations);
    harness.deterministicParseMultiSourceTransfer.mockReturnValue({
      destinationName: "Kolwezi",
      sourceNames: ["Hadi 1"],
      targetQty: 10,
      optional: false,
    });
    harness.matchLocationByName
      .mockResolvedValueOnce({ matched: locations[1], candidates: [] })
      .mockResolvedValueOnce({ matched: locations[0], candidates: [] });
    harness.buildStockTransferByTargetQuantityContext.mockResolvedValue({
      destinationLocationId: 9,
      destinationLocationName: "Kolwezi",
      targetQty: 10,
      achievedQty: 0,
      shortfall: true,
      noEligibleStock: true,
      drafts: [],
    });

    const result = await run("transfer 10 bales to Kolwezi from Hadi 1 same stock group");

    expect(result.stockTransferDraft).toBeUndefined();
    expect(result.stockTransferDrafts).toBeUndefined();
    expect(result.stockTransferResponseOverride).toContain("I didn't find any eligible stock");
    expect(result.stockTransferResponseOverride).toContain("so I did not create a transfer draft");
  });

  it("falls back safely when analysis extraction fails", async () => {
    harness.state.selectResults.push(locations);
    harness.callAIWithFallback.mockRejectedValue(new Error("provider down"));

    const result = await run("suggest a transfer from Hadi 1 to Kolwezi");

    expect(result.stockTransferDraft).toBeUndefined();
    expect(result.stockTransferDrafts).toBeUndefined();
    expect(result.stockTransferResponseOverride).toContain("I wasn't able to build a stock transfer draft");
  });
});
