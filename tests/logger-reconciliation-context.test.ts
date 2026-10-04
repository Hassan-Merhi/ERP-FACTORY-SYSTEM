import { describe, expect, it } from "vitest";

import { __loggerTesting } from "../server/lib/logger";

function pretty(context: Record<string, unknown>): string {
  const sanitized = __loggerTesting.sanitiseContext(context);
  return __loggerTesting.formatPrettyContext(sanitized).join(" ");
}

describe("reconciliation pretty-log context", () => {
  it("keeps discrepancy codes, counts, snapshots, and trace fields", () => {
    const line = pretty({
      event: "convergence.scheduledreconcile",
      requestId: "scheduler-request-1",
      companyId: 7,
      buildVersion: "abc12345",
      discrepancyCount: 2,
      discrepancyCodes: ["DAYBOOK_MISSING", "STOCK_VALUE_MISMATCH"],
      accountingSnapshots: 8,
      stockSnapshots: 5,
    });

    expect(line).toContain("event=convergence.scheduledreconcile");
    expect(line).toContain("requestId=scheduler-request-1");
    expect(line).toContain("companyId=7");
    expect(line).toContain("buildVersion=abc12345");
    expect(line).toContain("discrepancyCount=2");
    expect(line).toContain('discrepancyCodes=["DAYBOOK_MISSING","STOCK_VALUE_MISMATCH"]');
    expect(line).toContain("accountingSnapshots=8");
    expect(line).toContain("stockSnapshots=5");
  });

  it("keeps reconciliation summary counts including zero values", () => {
    const line = pretty({
      companies: 3,
      clean: 1,
      withDiscrepancies: 1,
      rejected: 1,
      failed: 0,
      discrepancies: 2,
    });

    expect(line).toContain("companies=3");
    expect(line).toContain("clean=1");
    expect(line).toContain("withDiscrepancies=1");
    expect(line).toContain("rejected=1");
    expect(line).toContain("failed=0");
    expect(line).toContain("discrepancies=2");
  });

  it("renders issue arrays and checked objects as JSON after redaction", () => {
    const line = pretty({
      issueCount: 1,
      issueCodes: ["LEDGER_DRIFT"],
      issues: [
        {
          code: "LEDGER_DRIFT",
          authorization: "Bearer should-not-leak",
          detail: { password: "also-secret", expected: "125", actual: "missing" },
        },
      ],
      checked: { vouchers: 4, stock: true },
    });

    expect(line).toContain("issueCount=1");
    expect(line).toContain('issueCodes=["LEDGER_DRIFT"]');
    expect(line).toContain('checked={"vouchers":4,"stock":true}');
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("should-not-leak");
    expect(line).not.toContain("also-secret");
    expect(line).not.toContain("[object Object]");
  });

  it("keeps large diagnostics bounded by the logger's sanitization limits", () => {
    const issues = Array.from({ length: 75 }, (_, index) => ({
      code: `ISSUE_${index}`,
      message: "x".repeat(3_000),
      nested: { level1: { level2: { level3: { level4: "too deep" } } } },
    }));

    const sanitized = __loggerTesting.sanitiseContext({ issues });
    const safeIssues = sanitized.issues as Array<Record<string, unknown>>;
    const line = __loggerTesting.formatPrettyContext(sanitized).join(" ");

    expect(safeIssues).toHaveLength(50);
    expect(String(safeIssues[0]?.message).length).toBeLessThanOrEqual(2_001);
    expect(line).toContain("ISSUE_49");
    expect(line).not.toContain("ISSUE_50");
    expect(line).toContain("[MaxDepth]");
  });
});
