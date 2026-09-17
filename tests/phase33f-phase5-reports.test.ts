import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("../server/chat/reports/implementations/reportShardSupport", () => ({
  db: { execute: harness.execute },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: Array.from(strings), values }),
}));

import {
  phase5QueryTypes,
  phase5ReportShard,
} from "../server/chat/reports/implementations/phase5ReportShard";

function ctx(queryType: string, extraParams: Record<string, unknown> = {}) {
  return {
    companyId: 7,
    params: { queryType, ...extraParams },
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
    todayStr: "2026-09-17",
    todayDate: new Date("2026-09-17T00:00:00Z"),
    rowLimit: 50,
    fmt: (value: number) => `$${value.toFixed(2)}`,
    fmtDec: (value: number) => value.toFixed(2),
  } as any;
}

describe("Phase 33F phase 5 report shard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the full phase-5 query family", () => {
    expect(phase5ReportShard.name).toBe("phase-5");
    expect(phase5QueryTypes).toEqual([
      "trial_balance",
      "purchase_order_detail",
      "container_cost_breakdown",
      "worker_document_expiry",
      "stock_transfers",
      "cash_flow_summary",
      "ledger_account_balance",
      "daily_report",
      "profit_by_location",
      "debit_note_summary",
    ]);
    expect(phase5ReportShard.queryTypes).toBe(phase5QueryTypes);
  });

  it("returns actionable prompts before querying for missing PO/container identifiers", async () => {
    const po = await phase5ReportShard.run(ctx("purchase_order_detail"));
    expect(po).toEqual(
      expect.objectContaining({
        queryType: "purchase_order_detail",
        title: "Purchase Order Detail",
        summary: "Please specify a PO number.",
      })
    );

    const container = await phase5ReportShard.run(ctx("container_cost_breakdown"));
    expect(container).toEqual(
      expect.objectContaining({
        queryType: "container_cost_breakdown",
        title: "Container Cost Breakdown",
        summary: "Please specify a container number.",
      })
    );
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("builds a balanced trial-balance table and grand totals from scoped rows", async () => {
    harness.execute.mockResolvedValueOnce({
      rows: [
        { name: "Cash", account_type: "ASSET", code: "1000", total_dr: "125", total_cr: "25" },
        { name: "Sales", account_type: "INCOME", code: "4000", total_dr: "5", total_cr: "105" },
      ],
    });

    const result = await phase5ReportShard.run(ctx("trial_balance"));
    expect(result.queryType).toBe("trial_balance");
    expect(result.noData).toBe(false);
    expect(result.table?.rows).toHaveLength(3);
    expect(result.table?.rows.at(-1)).toEqual(["", "GRAND TOTAL", "", "$130.00", "$130.00", "$0.00", "—"]);
    expect(result.stats).toEqual(
      expect.arrayContaining([
        { label: "Total Debits", value: "$130.00" },
        { label: "Total Credits", value: "$130.00" },
        { label: "Net", value: "$0.00", highlight: "positive" },
      ])
    );
  });

  it("reports a clean no-match result for unknown purchase orders", async () => {
    harness.execute.mockResolvedValueOnce({ rows: [] });
    const result = await phase5ReportShard.run(ctx("purchase_order_detail", { containerNumber: "PO-MISSING" }));
    expect(result.summary).toBe('No PO found matching "PO-MISSING".');
    expect(harness.execute).toHaveBeenCalledOnce();
  });
});
