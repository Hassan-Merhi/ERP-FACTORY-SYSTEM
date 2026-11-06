import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = { selectResults: [] as unknown[][], inserts: [] as Record<string, unknown>[] };
  const select = vi.fn(() => {
    const result = state.selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) builder[method] = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  });
  const insert = vi.fn(() => ({
    values: vi.fn(async (value: Record<string, unknown>) => {
      state.inserts.push(value);
    }),
  }));
  return { state, db: { select, insert } };
});

vi.mock("../server/db", () => ({ db: harness.db }));

import {
  getSmartTransferFeedbackSummary,
  recordSmartTransferImportFeedback,
  resetSmartTransferFeedback,
} from "../server/services/smartTransferFeedback";

const NOW = new Date("2026-03-20T12:00:00Z");
const at = (iso: string) => new Date(iso);
const line = (
  stockItemId: number,
  sourceLocationId: number,
  quantity: number,
  extra: Record<string, unknown> = {}
) => ({
  stockItemId,
  sourceLocationId,
  quantity,
  forecastDailyRate: 0,
  itemScore: 0,
  ...extra,
});

type Log = {
  id?: number;
  actionName: string;
  sessionId: string | null;
  userId?: string;
  createdAt: Date;
  createdRecordId?: number | null;
  inputJson?: unknown;
  outputJson?: unknown;
};
const log = (row: Log) => ({ id: 1, userId: "u1", createdRecordId: null, inputJson: {}, outputJson: {}, ...row });
const preview = (sessionId: string, createdAt: string, output: Record<string, unknown>) =>
  log({ actionName: "smart_transfer_preview_v4", sessionId, createdAt: at(createdAt), outputJson: output });
const importLog = (
  sessionId: string | null,
  createdAt: string,
  destinationLocationId: unknown,
  output: Record<string, unknown>,
  id = 1
) =>
  log({
    id,
    actionName: "smart_transfer_import_v4",
    sessionId,
    createdAt: at(createdAt),
    inputJson: { destinationLocationId },
    outputJson: output,
  });
const approval = (sessionId: string, output: Record<string, unknown>, createdRecordId: number | null = null) =>
  log({
    actionName: "smart_transfer_approval_v4",
    sessionId,
    createdAt: at("2026-03-19T00:00:00Z"),
    createdRecordId,
    outputJson: output,
  });

beforeEach(() => {
  vi.clearAllMocks();
  harness.state.selectResults.splice(0);
  harness.state.inserts.splice(0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  expect(harness.state.selectResults).toEqual([]);
});

describe("recordSmartTransferImportFeedback", () => {
  it("compares an import with the latest preview for the same destination", async () => {
    harness.state.selectResults.push([
      preview("stf_other", "2026-03-20T11:00:00Z", { destinationLocationId: 6, lines: [line(1, 10, 99)] }),
      preview("stf_match", "2026-03-20T10:00:00Z", {
        destinationLocationId: "5",
        lines: [line(1, 10, 10), line(2, 10, 6), line(3, 11, 4)],
      }),
    ]);
    const result = await recordSmartTransferImportFeedback({
      companyId: 3,
      userId: "u1",
      destinationLocationId: 5,
      sourceLocationIds: [10, 12],
      importedItems: [line(1, 10, 8), line(2, 12, 6), line(4, 10, 3)],
    });
    expect(result.sessionId).toBe("stf_match");
    expect(result.matchedPreview).toBe(true);
    // Kept 8 of item 1; item 2 kept but moved to another source; item 3 dropped; item 4 added.
    expect(result.comparison).toEqual({
      suggestedQuantity: 20,
      finalQuantity: 17,
      keptQuantity: 8,
      addedQuantity: 9,
      removedQuantity: 12,
      suggestedLineCount: 3,
      finalLineCount: 3,
      keptLineCount: 1,
      suggestedItemCount: 3,
      keptItemCount: 2,
      sourceChangedQuantity: 6,
      quantityKeptPct: 40,
      lineKeptPct: 33.33,
      itemKeptPct: 66.67,
      sourceKeptPct: 57.14,
      edited: true,
    });
    expect(harness.state.inserts[0]).toMatchObject({
      sessionId: "stf_match",
      actionName: "smart_transfer_import_v4",
      inputJson: { destinationLocationId: 5, sourceLocationIds: [10, 12] },
      outputJson: { matchedPreview: true, comparison: result.comparison },
    });
  });

  it("records an unmatched import under the caller's or a new session", async () => {
    harness.state.selectResults.push([]);
    const given = await recordSmartTransferImportFeedback({
      companyId: 3,
      userId: "u1",
      destinationLocationId: 5,
      sourceLocationIds: [],
      importedItems: [line(1, 10, 1)],
      sessionId: "stf_given",
    });
    expect(given).toEqual({ sessionId: "stf_given", matchedPreview: false, comparison: null });

    harness.state.selectResults.push([]);
    const fresh = await recordSmartTransferImportFeedback({
      companyId: 3,
      userId: "u1",
      destinationLocationId: 5,
      sourceLocationIds: [],
      importedItems: "not a list",
    });
    expect(fresh.sessionId).toMatch(/^stf_[0-9a-f-]{36}$/);
    expect(harness.state.inserts[1]).toMatchObject({ outputJson: { importedItems: [], comparison: null } });
  });

  it("reports an untouched import as unedited", async () => {
    harness.state.selectResults.push([
      preview("stf_s", "2026-03-20T10:00:00Z", { destinationLocationId: 5, lines: [line(1, 10, 4)] }),
    ]);
    const { comparison } = await recordSmartTransferImportFeedback({
      companyId: 3,
      userId: "u1",
      destinationLocationId: 5,
      sourceLocationIds: [10],
      importedItems: [line(1, 10, 4)],
    });
    expect(comparison).toMatchObject({ edited: false, quantityKeptPct: 100, sourceKeptPct: 100, addedQuantity: 0 });
  });
});

describe("resetSmartTransferFeedback", () => {
  it("logs a reset marker", async () => {
    const sessionId = await resetSmartTransferFeedback({ companyId: 3, userId: "u9" });
    expect(sessionId).toMatch(/^stf_reset_/);
    expect(harness.state.inserts).toEqual([
      {
        companyId: 3,
        userId: "u9",
        sessionId,
        actionType: "write",
        actionName: "smart_transfer_feedback_reset_v4",
        outputJson: { resetAt: NOW.toISOString() },
        status: "success",
      },
    ]);
  });
});

describe("getSmartTransferFeedbackSummary approval matching", () => {
  const transfer = (
    transferId: number,
    destinationLocationId: number,
    createdAt: string,
    extra: Record<string, unknown> = {}
  ) => ({
    transferId,
    voucherId: transferId + 100,
    destinationLocationId,
    inventoryApplied: true,
    optional: false,
    voucherDate: "2026-03-20",
    createdAt: at(createdAt),
    ...extra,
  });
  const items = [line(1, 10, 10), line(2, 10, 5)];

  it("matches each unapproved import to its most similar, closest transfer once", async () => {
    harness.state.selectResults.push(
      [],
      [
        preview("s1", "2026-03-20T09:55:00Z", {
          destinationLocationId: 5,
          // The user trimmed item 1 from 12 to 10 before importing.
          lines: [line(1, 10, 12, { forecastDailyRate: 2 }), line(2, 10, 5, { forecastDailyRate: 1 }), line(1, 10, 0)],
        }),
        importLog("s1", "2026-03-20T10:00:00Z", 5, { importedItems: items }, 41),
        importLog("s2", "2026-03-20T10:05:00Z", 5, { importedItems: items }, 42),
        importLog("s3", "2026-03-20T10:30:00Z", 5, { importedItems: [line(8, 10, 4)] }, 43),
        approval("s3", {}),
        importLog("s4", "2026-03-20T10:30:00Z", 5, { importedItems: [] }, 44),
        importLog("s5", "2026-03-20T10:30:00Z", "abc", { importedItems: items }, 45),
        importLog(null, "2026-03-20T10:30:00Z", 5, { importedItems: items }, 46),
        importLog("s7", "2026-03-20T11:58:00Z", 5, { importedItems: items }, 47),
        importLog("s8", "2026-03-20T10:00:00Z", 5, { importedItems: [line(7, 10, 3)] }, 48),
      ],
      [
        transfer(1, 5, "2026-03-20T10:10:00Z"),
        transfer(2, 5, "2026-03-20T10:40:00Z", { inventoryApplied: null, optional: true }),
        transfer(3, 6, "2026-03-20T10:05:00Z"),
        transfer(4, 5, "2026-03-20T09:50:00Z"),
        transfer(5, 5, "2026-03-20T10:01:00Z"),
        transfer(6, 5, "2026-03-20T10:31:00Z"),
      ],
      [
        { transferId: 1, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
        { transferId: 1, stockItemId: 2, sourceLocationId: 10, quantity: "5.9" },
        { transferId: 2, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
        { transferId: 2, stockItemId: 2, sourceLocationId: "11", quantity: "5" },
        { transferId: 3, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
        { transferId: 3, stockItemId: 2, sourceLocationId: 10, quantity: "5" },
        { transferId: 4, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
        { transferId: 4, stockItemId: 2, sourceLocationId: 10, quantity: "5" },
        { transferId: 5, stockItemId: 9, sourceLocationId: 10, quantity: "1" },
        { transferId: 6, stockItemId: 8, sourceLocationId: 10, quantity: "4" },
      ],
      []
    );

    // s1 takes transfer 1, so s2 (five minutes later) falls back to transfer 2.
    // s3 is already approved, s4 and s5 are unusable, s7 has nothing in its
    // window and s8 resembles none of the transfers.
    const summary = await getSmartTransferFeedbackSummary(3, 30);
    expect(summary.periodDays).toBe(30);

    const approvals = harness.state.inserts;
    expect(approvals.map((row) => [row.sessionId, (row.outputJson as Record<string, unknown>).transferId])).toEqual([
      ["s1", 1],
      ["s2", 2],
    ]);
    expect(approvals[0]).toMatchObject({
      companyId: 3,
      userId: "u1",
      actionType: "write",
      actionName: "smart_transfer_approval_v4",
      createdRecordId: 101,
      inputJson: { importLogId: 41, matchedBy: "destination-item-source-quantity-time" },
      outputJson: {
        voucherId: 101,
        voucherDate: "2026-03-20",
        destinationLocationId: 5,
        inventoryApplied: true,
        optional: false,
        matchConfidencePct: 100,
        finalItems: items,
        forecastByItem: { 1: 2, 2: 1 },
        // Compared against the original preview, not the edited import.
        comparison: expect.objectContaining({ suggestedQuantity: 17, removedQuantity: 2, edited: true }),
      },
    });
    // Item 2 moved from source 10 to 11: 35 + 25 × 66.67% twice + 15, from the
    // already-rounded percentages, = 83.335 → 83.34.
    expect(approvals[1]).toMatchObject({
      outputJson: {
        inventoryApplied: false,
        optional: true,
        matchConfidencePct: 83.34,
        forecastByItem: {},
        comparison: expect.objectContaining({ sourceChangedQuantity: 5, edited: true }),
      },
    });
  });

  it("stops early when nothing needs matching", async () => {
    harness.state.selectResults.push(
      [],
      [importLog("s1", "2026-03-20T10:00:00Z", 5, { importedItems: items }), approval("s1", {})],
      []
    );
    await getSmartTransferFeedbackSummary(3, 30);
    harness.state.selectResults.push(
      [],
      [importLog("s1", "2026-03-20T10:00:00Z", 5, { importedItems: items })],
      [],
      []
    );
    await getSmartTransferFeedbackSummary(3, 30);
    expect(harness.state.inserts).toEqual([]);
  });

  it("prefers the closer transfer when two are equally similar", async () => {
    harness.state.selectResults.push(
      [],
      [importLog("s1", "2026-03-20T10:00:00Z", 5, { importedItems: items })],
      [transfer(1, 5, "2026-03-20T11:30:00Z"), transfer(2, 5, "2026-03-20T10:02:00Z")],
      [
        { transferId: 1, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
        { transferId: 1, stockItemId: 2, sourceLocationId: 10, quantity: "5" },
        { transferId: 2, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
        { transferId: 2, stockItemId: 2, sourceLocationId: 10, quantity: "5" },
      ],
      []
    );
    await getSmartTransferFeedbackSummary(3, 30);
    expect((harness.state.inserts[0].outputJson as Record<string, unknown>).transferId).toBe(2);
  });

  it("rejects transfers just outside the time window", async () => {
    for (const createdAt of ["2026-03-17T09:54:00Z", "2026-03-19T10:01:00Z"]) {
      harness.state.selectResults.push(
        [],
        [importLog("s1", "2026-03-17T10:00:00Z", 5, { importedItems: items })],
        [transfer(1, 5, createdAt)],
        [
          { transferId: 1, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
          { transferId: 1, stockItemId: 2, sourceLocationId: 10, quantity: "5" },
        ],
        []
      );
      await getSmartTransferFeedbackSummary(3, 30);
    }
    expect(harness.state.inserts).toEqual([]);
  });

  it("ignores transfers more than 48 hours after the import", async () => {
    harness.state.selectResults.push(
      [],
      [importLog("s1", "2026-03-17T10:00:00Z", 5, { importedItems: items })],
      [transfer(1, 5, "2026-03-19T10:01:00Z"), transfer(2, 5, "2026-03-17T09:56:00Z")],
      [
        { transferId: 1, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
        { transferId: 1, stockItemId: 2, sourceLocationId: 10, quantity: "5" },
        { transferId: 2, stockItemId: 1, sourceLocationId: 10, quantity: "10" },
        { transferId: 2, stockItemId: 2, sourceLocationId: 10, quantity: "5" },
      ],
      []
    );
    await getSmartTransferFeedbackSummary(3, 30);
    // Four minutes before the import is still inside the tolerance.
    expect((harness.state.inserts[0].outputJson as Record<string, unknown>).transferId).toBe(2);
  });
});

describe("getSmartTransferFeedbackSummary metrics", () => {
  const comparison = (over: Record<string, unknown>) => ({
    suggestedQuantity: 0,
    suggestedLineCount: 0,
    suggestedItemCount: 0,
    keptQuantity: 0,
    quantityKeptPct: 0,
    lineKeptPct: 0,
    itemKeptPct: 0,
    sourceKeptPct: 0,
    addedQuantity: 0,
    removedQuantity: 0,
    sourceChangedQuantity: 0,
    edited: false,
    ...over,
  });

  it("clamps the period and starts after the latest reset", async () => {
    const reset = { createdAt: at("2026-03-15T00:00:00Z") };
    harness.state.selectResults.push([reset], [], []);
    const summary = await getSmartTransferFeedbackSummary(3, 3);
    expect(summary).toMatchObject({
      feedbackVersion: 4,
      learningMode: "observe-only",
      periodDays: 7,
      since: "2026-03-15T00:00:00.000Z",
      resetAt: "2026-03-15T00:00:00.000Z",
      counts: { previews: 0, imports: 0, approvals: 0, finalizedPerformanceSamples: 0 },
      adoption: { importRatePct: 0, approvalRatePct: 0 },
      lastUpdatedAt: NOW.toISOString(),
      recommendations: [
        "Collect at least five approved smart transfers before changing forecasting or source-selection weights.",
      ],
    });
    expect(summary.editing).toEqual({
      editedImportPct: 0,
      quantityKeptPct: 0,
      lineKeptPct: 0,
      itemKeptPct: 0,
      sourceKeptPct: 0,
      addedQuantity: 0,
      removedQuantity: 0,
      sourceChangedQuantity: 0,
    });
    expect(summary.performance).toMatchObject({
      sampleSize: 0,
      forecastAccuracyPct: 0,
      forecastBiasPct: 0,
      underForecastRatePct: 0,
      overForecastRatePct: 0,
    });

    // A reset older than the period is ignored; 0 days means the 90-day default.
    harness.state.selectResults.push([{ createdAt: at("2025-01-01T00:00:00Z") }], [], []);
    const older = await getSmartTransferFeedbackSummary(3, 0);
    expect(older.periodDays).toBe(90);
    expect(older.since).toBe(new Date(NOW.getTime() - 90 * 86_400_000).toISOString());
    expect(older.resetAt).toBe("2025-01-01T00:00:00.000Z");

    harness.state.selectResults.push([], [], []);
    const capped = await getSmartTransferFeedbackSummary(3, 1000);
    expect(capped.periodDays).toBe(365);
    expect(capped.resetAt).toBeNull();
  });

  it("weights editing metrics by approvals, falling back to imports", async () => {
    harness.state.selectResults.push(
      [],
      [],
      [
        preview("s1", "2026-03-10T00:00:00Z", {}),
        preview("s2", "2026-03-10T00:00:00Z", {}),
        preview("s3", "2026-03-10T00:00:00Z", {}),
        preview("s4", "2026-03-10T00:00:00Z", {}),
        importLog("s1", "2026-03-10T00:00:00Z", 5, {
          comparison: comparison({ edited: true, suggestedQuantity: 4, quantityKeptPct: 25 }),
        }),
        importLog("s2", "2026-03-10T00:00:00Z", 5, {
          comparison: comparison({ suggestedQuantity: 4, quantityKeptPct: 75 }),
        }),
        importLog("s3", "2026-03-10T00:00:00Z", 5, { comparison: null }),
      ]
    );
    const fromImports = await getSmartTransferFeedbackSummary(3, 30);
    expect(fromImports.adoption).toEqual({ importRatePct: 75, approvalRatePct: 0 });
    expect(fromImports.editing).toMatchObject({ editedImportPct: 50, quantityKeptPct: 50 });

    harness.state.selectResults.push(
      [],
      [],
      [
        preview("s1", "2026-03-10T00:00:00Z", {}),
        importLog("s1", "2026-03-10T00:00:00Z", 5, {
          comparison: comparison({ suggestedQuantity: 100, quantityKeptPct: 0 }),
        }),
        approval("s1", {
          voucherId: "x",
          comparison: comparison({
            suggestedQuantity: 15,
            quantityKeptPct: 100,
            suggestedLineCount: 2,
            lineKeptPct: 100,
            suggestedItemCount: 2,
            itemKeptPct: 100,
            keptQuantity: 15,
            sourceKeptPct: 100,
          }),
        }),
        approval("s2", {
          comparison: comparison({
            suggestedQuantity: 10,
            quantityKeptPct: 50,
            suggestedLineCount: 2,
            lineKeptPct: 50,
            suggestedItemCount: 2,
            itemKeptPct: 50,
            keptQuantity: 5,
            sourceKeptPct: 40,
            addedQuantity: 3,
            removedQuantity: 5,
            sourceChangedQuantity: 2,
          }),
        }),
        approval("s3", { comparison: null }),
      ]
    );
    const fromApprovals = await getSmartTransferFeedbackSummary(3, 30);
    expect(fromApprovals.adoption).toEqual({ importRatePct: 100, approvalRatePct: 300 });
    expect(fromApprovals.editing).toEqual({
      editedImportPct: 0,
      quantityKeptPct: 80,
      lineKeptPct: 75,
      itemKeptPct: 75,
      sourceKeptPct: 85,
      addedQuantity: 3,
      removedQuantity: 5,
      sourceChangedQuantity: 2,
    });
  });

  it("measures forecast accuracy on finalized transfers observed for at least a week", async () => {
    const finalItems = [line(1, 10, 10), line(2, 10, 5)];
    harness.state.selectResults.push(
      [],
      [],
      [
        approval("a1", { voucherId: 101, finalItems, forecastByItem: { 1: 2, 2: "1" } }),
        approval("a2", { finalItems }, 102), // not applied to inventory
        approval("a3", { voucherId: 103, finalItems }), // only two days old
        approval("a4", { voucherId: 104, finalItems }), // deleted transfer
        approval("a5", { voucherId: 105, finalItems: [] }),
        approval("a6", { voucherId: "x" }),
        approval("a7", { voucherId: 107, finalItems: [line(3, 10, 2)] }), // 60 days old: capped at 30
      ],
      [
        { voucherId: 101, voucherDate: "2026-03-01", destinationLocationId: 5, inventoryApplied: true },
        { voucherId: 102, voucherDate: "2026-03-01", destinationLocationId: 5, inventoryApplied: false },
        { voucherId: 103, voucherDate: "2026-03-18", destinationLocationId: 5, inventoryApplied: true },
        { voucherId: 105, voucherDate: "2026-03-01", destinationLocationId: 5, inventoryApplied: true },
        { voucherId: 107, voucherDate: "2026-01-19", destinationLocationId: 6, inventoryApplied: true },
      ],
      [
        { stockItemId: 1, locationId: 5, voucherDate: "2026-03-01", quantity: "20" },
        { stockItemId: 1, locationId: 5, voucherDate: "2026-03-20", quantity: "10" },
        { stockItemId: 2, locationId: 5, voucherDate: "2026-03-10", quantity: "10" },
        { stockItemId: 2, locationId: 6, voucherDate: "2026-03-10", quantity: "100" },
        { stockItemId: 1, locationId: 5, voucherDate: "2026-02-28", quantity: "100" },
        { stockItemId: 1, locationId: 5, voucherDate: "2026-03-21", quantity: "100" },
        { stockItemId: 3, locationId: 6, voucherDate: "2026-02-18", quantity: "4" },
        { stockItemId: 3, locationId: 6, voucherDate: "2026-02-19", quantity: "1" },
      ]
    );
    const summary = await getSmartTransferFeedbackSummary(3, 90);
    // 101: 19 days, predicted (2 + 1) × 19 = 57, actual 40.
    // 107: 30 days from 2026-01-19 ends 2026-02-18, no forecast, actual 4.
    expect(summary.counts).toMatchObject({ approvals: 7, finalizedPerformanceSamples: 2 });
    expect(summary.performance).toMatchObject({
      sampleSize: 2,
      // (70.18 × 40 + 0 × 4) / 44 and (42.5 × 40 + (−100) × 4) / 44.
      forecastAccuracyPct: 63.8,
      forecastBiasPct: 29.55,
      // (266.67 × 15 + 200 × 2) / 17.
      observedSalesToTransferPct: 258.82,
      underForecastRatePct: 50,
      overForecastRatePct: 50,
    });
    // Seven approvals but no comparisons logged: editing metrics read as zero,
    // and two samples are too few for forecast tuning advice.
    expect(summary.recommendations).toEqual([
      "Users frequently reduce suggested quantities; review demand coverage and concentration caps before increasing automation.",
      "Users frequently change source locations; review source reserve days, pending commitments and route-history weighting.",
    ]);
  });

  const run = async (rate: number, kept: { quantity: number; source: number }) => {
    const approvals = [1, 2, 3, 4, 5].map((n) =>
      approval(`a${n}`, {
        voucherId: n,
        finalItems: [line(1, 10, 10)],
        forecastByItem: { 1: rate },
        comparison: comparison({
          suggestedQuantity: 10,
          quantityKeptPct: kept.quantity,
          keptQuantity: 10,
          sourceKeptPct: kept.source,
        }),
      })
    );
    harness.state.selectResults.push(
      [],
      [],
      approvals,
      [1, 2, 3, 4, 5].map((voucherId) => ({
        voucherId,
        voucherDate: "2026-03-10",
        destinationLocationId: 5,
        inventoryApplied: true,
      })),
      // Ten days observed at every transfer: 10 units sold each.
      [1, 2, 3, 4, 5].map(() => ({ stockItemId: 1, locationId: 5, voucherDate: "2026-03-12", quantity: "2" }))
    );
    return getSmartTransferFeedbackSummary(3, 90);
  };

  it("recommends tuning once enough approvals show a consistent pattern", async () => {
    let summary = await run(2, { quantity: 60, source: 50 });
    expect(summary.performance).toMatchObject({
      forecastBiasPct: 100,
      overForecastRatePct: 100,
      underForecastRatePct: 0,
    });
    expect(summary.recommendations).toEqual([
      "Users frequently reduce suggested quantities; review demand coverage and concentration caps before increasing automation.",
      "Users frequently change source locations; review source reserve days, pending commitments and route-history weighting.",
      "Forecasts are running high versus observed destination sales; reduce recent-sales acceleration or coverage weighting cautiously.",
    ]);

    summary = await run(0.5, { quantity: 70, source: 70 });
    expect(summary.performance).toMatchObject({
      forecastBiasPct: -50,
      underForecastRatePct: 100,
      overForecastRatePct: 0,
    });

    expect(summary.recommendations).toEqual([
      "Forecasts are running low versus observed destination sales; increase recent-demand sensitivity cautiously.",
    ]);

    // Selling a third more than forecast already counts as under-forecast.
    summary = await run(0.75, { quantity: 70, source: 70 });
    expect(summary.performance).toMatchObject({ forecastBiasPct: -25, underForecastRatePct: 100 });
    summary = await run(0.85, { quantity: 70, source: 70 });
    expect(summary.performance).toMatchObject({ underForecastRatePct: 0, overForecastRatePct: 0 });

    summary = await run(1, { quantity: 80, source: 90 });
    expect(summary.performance).toMatchObject({ forecastAccuracyPct: 100, forecastBiasPct: 0 });
    expect(summary.recommendations).toEqual([
      "The current rules are stable enough for a limited pilot of stronger default recommendations, while keeping manual approval.",
    ]);

    summary = await run(1, { quantity: 79.99, source: 90 });
    expect(summary.recommendations).toEqual([
      "Keep the current deterministic rules and continue collecting feedback; no tuning change is justified yet.",
    ]);
  });
});
