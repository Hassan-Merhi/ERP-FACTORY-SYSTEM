import { describe, expect, it } from "vitest";
import { parseWeeklyBonusPaymentCommand } from "./weeklyBonusPaymentPolicy";

const command = {
  confirm: true, paymentDate: "2026-11-02", cashAccountId: 18, currency: "USD",
  selections: [{ weekStart: "2026-10-26", workerId: 11, expectedAmount: "15.00" }],
};

describe("Phase 15 weekly bonus payment policy", () => {
  it("requires deliberate confirmation, a Monday, positive USD and a selected account", () => {
    expect(parseWeeklyBonusPaymentCommand(command)).toMatchObject(command);
    expect(() => parseWeeklyBonusPaymentCommand({ ...command, confirm: false })).toThrow();
    expect(() => parseWeeklyBonusPaymentCommand({ ...command, cashAccountId: 0 })).toThrow();
    expect(() => parseWeeklyBonusPaymentCommand({ ...command, currency: "LBP" })).toThrow();
    expect(() => parseWeeklyBonusPaymentCommand({
      ...command, selections: [{ weekStart: "2026-10-27", workerId: 11, expectedAmount: "15.00" }],
    })).toThrow();
    expect(() => parseWeeklyBonusPaymentCommand({
      ...command, selections: [{ weekStart: "2026-10-26", workerId: 11, expectedAmount: "0" }],
    })).toThrow();
  });
  it("rejects duplicate worker/week selections and malformed dates", () => {
    expect(() => parseWeeklyBonusPaymentCommand({ ...command, selections: [
      command.selections[0], command.selections[0],
    ] })).toThrow(/Duplicate worker/);
    expect(() => parseWeeklyBonusPaymentCommand({ ...command, paymentDate: "2026-02-30" })).toThrow();
  });
  it("normalizes amounts and sorts selections deterministically", () => {
    const parsed = parseWeeklyBonusPaymentCommand({
      ...command, selections: [
        { weekStart: "2026-11-02", workerId: 2, expectedAmount: 7 },
        { weekStart: "2026-10-26", workerId: 3, expectedAmount: "15" },
      ],
    });
    expect(parsed.selections).toEqual([
      { weekStart: "2026-10-26", workerId: 3, expectedAmount: "15.00" },
      { weekStart: "2026-11-02", workerId: 2, expectedAmount: "7.00" },
    ]);
  });
});
