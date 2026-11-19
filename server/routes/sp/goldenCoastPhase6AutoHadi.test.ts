import { describe, expect, it } from "vitest";
import { GoldenCoastPhase6AutoHadiError, selectGoldenCoastAutomaticHadiCashAccount } from "./goldenCoastAutoHadi";

describe("Golden Coast Phase 6 automatic HADI cash routing", () => {
  it("prefers the single active HADI Cash ledger over bank fallbacks", () => {
    expect(
      selectGoldenCoastAutomaticHadiCashAccount({
        cashLedgers: [{ kind: "ledger", id: 11, name: "HADI Cash", source: "cash-ledger" }],
        fallbackAccounts: [{ kind: "bank", id: 22, name: "HADI Bank", source: "bank-account" }],
      })
    ).toEqual({ kind: "ledger", id: 11, name: "HADI Cash" });
  });

  it("uses one bank destination when no Cash ledger exists", () => {
    expect(
      selectGoldenCoastAutomaticHadiCashAccount({
        cashLedgers: [],
        fallbackAccounts: [{ kind: "bank", id: 22, name: "HADI Bank", source: "bank-account" }],
      })
    ).toEqual({ kind: "bank", id: 22, name: "HADI Bank" });
  });

  it("fails closed instead of guessing between multiple HADI Cash ledgers", () => {
    expect(() =>
      selectGoldenCoastAutomaticHadiCashAccount({
        cashLedgers: [
          { kind: "ledger", id: 11, name: "Cash A", source: "cash-ledger" },
          { kind: "ledger", id: 12, name: "Cash B", source: "cash-ledger" },
        ],
        fallbackAccounts: [],
      })
    ).toThrowError(GoldenCoastPhase6AutoHadiError);
  });

  it("fails closed when HADI has no receiving Cash/Bank account", () => {
    expect(() => selectGoldenCoastAutomaticHadiCashAccount({ cashLedgers: [], fallbackAccounts: [] })).toThrowError(
      /requires an active HADI Cash ledger/i
    );
  });

  it("fails closed instead of guessing between multiple bank fallbacks", () => {
    expect(() =>
      selectGoldenCoastAutomaticHadiCashAccount({
        cashLedgers: [],
        fallbackAccounts: [
          { kind: "bank", id: 21, name: "Bank A", source: "bank-account" },
          { kind: "bank", id: 22, name: "Bank B", source: "bank-account" },
        ],
      })
    ).toThrowError(/ambiguous/i);
  });
});
