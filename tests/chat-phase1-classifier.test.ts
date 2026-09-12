/**
 * Regression tests for the Phase 1 data-query classifier extracted from
 * chatService.ts into server/chat/phase1Classifier.ts (DB-free module).
 *
 * The keyword matcher is a business-critical gate: only messages that match
 * it may trigger the AI-classified read-only ERP query path. The date context
 * feeds the classifier prompt, so its shape must stay stable.
 */
import { describe, expect, it } from "vitest";
import {
  isPhase1DataQuery,
  buildPhase1DateContext,
  buildPhase1ClassifierPrompt,
} from "../server/chat/phase1Classifier";

describe("isPhase1DataQuery", () => {
  it.each([
    ["Show me the profit and loss for this month", true],
    ["What is our cash position?", true],
    ["our customers who owe money", true],
    ["top 5 customers by revenue", true],
    ["how much stock do we have of bales", true],
    ["low stock items", true],
    ["container status for MSCU1234567", true],
    ["pending offload containers", true],
    ["supplier statement for Alpha Trading", true],
    ["trial balance", true],
    ["sales analysis by item", true],
    ["day report yesterday", true],
  ])("classifies %j as a Phase 1 data query", (message, expected) => {
    expect(isPhase1DataQuery(message)).toBe(expected);
  });

  it.each([
    ["Book a meeting with the supplier", false],
    ["Add a payment voucher for 100 USD", false],
    ["Write me a Python script to sort a list", false],
    ["What is the capital of France?", false],
    ["Edit the file client/src/pages/Agents.tsx", false],
  ])("does not classify %j as a Phase 1 data query", (message) => {
    expect(isPhase1DataQuery(message)).toBe(false);
  });
});

describe("buildPhase1DateContext", () => {
  it("computes stable relative date strings for a fixed date", () => {
    const today = new Date(2026, 8, 12); // 2026-09-12 (Saturday)
    const ctx = buildPhase1DateContext(today);

    expect(ctx.todayStr).toBe("2026-09-12");
    expect(ctx.yesterdayStr).toBe("2026-09-11");
    expect(ctx.thisMonthStart).toBe("2026-09-01");
    expect(ctx.lastMonthStart).toBe("2026-08-01");
    expect(ctx.lastMonthEnd).toBe("2026-08-31");
    expect(ctx.last30Days).toBe("2026-08-13");
    // 2026-09-12 is a Saturday → this week starts Monday 2026-09-07.
    expect(ctx.thisWeekStart).toBe("2026-09-07");
    expect(ctx.lastWeekStart).toBe("2026-08-31");
    expect(ctx.lastWeekEnd).toBe("2026-09-06");
  });

  it("treats Sunday as the end of the previous Monday-started week", () => {
    const sunday = new Date(2026, 8, 13); // 2026-09-13 (Sunday)
    const ctx = buildPhase1DateContext(sunday);

    expect(ctx.thisWeekStart).toBe("2026-09-07");
    expect(ctx.lastWeekEnd).toBe("2026-09-06");
  });
});

describe("buildPhase1ClassifierPrompt", () => {
  it("embeds the date ranges and user message", () => {
    const prompt = buildPhase1ClassifierPrompt("cash position", buildPhase1DateContext(new Date(2026, 8, 12)));

    expect(prompt).toContain('User message: "cash position"');
    expect(prompt).toContain("Today: 2026-09-12 | Yesterday: 2026-09-11");
    expect(prompt).toContain("This month: 2026-09-01 to 2026-09-12 | Last month: 2026-08-01 to 2026-08-31");
    expect(prompt).toContain('"dateTo":"2026-09-12"');
    expect(prompt).toContain('{"queryType":"<one of the above>"');
  });
});
