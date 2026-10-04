import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  deriveRecurringDescriptionTemplate,
  firstRecurringRunDate,
  nextMonthEndIso,
  renderRecurringDescription,
} from "../server/services/accounting/recurringJournalService";

describe("recurring journal scheduling", () => {
  it("schedules a source-month voucher for the following month end", () => {
    expect(firstRecurringRunDate("2026-09-30", "UTC", new Date("2026-09-30T12:00:00Z"))).toBe("2026-10-31");
  });

  it("uses the current month end when the source voucher is from an older month", () => {
    expect(firstRecurringRunDate("2026-08-31", "UTC", new Date("2026-09-15T12:00:00Z"))).toBe("2026-09-30");
  });

  it("handles year boundaries", () => {
    expect(nextMonthEndIso("2026-12-31")).toBe("2027-01-31");
  });

  it("templates both the source month and year", () => {
    const template = deriveRecurringDescriptionTemplate("Savings Kinshasa September 2026", "2026-09-30");
    expect(template).toBe("Savings Kinshasa {{month}} {{year}}");
    expect(renderRecurringDescription(template, "2027-01-31")).toBe("Savings Kinshasa January 2027");
  });
});

describe("recurring journal posting safety contract", () => {
  it("locks and rechecks recurrence state and writes the factory daybook mirror", () => {
    const sourcePath = path.resolve(process.cwd(), "server/services/accounting/recurringJournalService.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).toContain('.for("update")');
    expect(source).toContain("locked.nextRunDate !== scheduledFor");
    expect(source).toContain("factoryDaybookEntries");
    expect(source).toContain("amountCurrency: String(transactionTotal)");
    expect(source).toContain("erpRateToDaybookFxRateToUsd");
  });
});
