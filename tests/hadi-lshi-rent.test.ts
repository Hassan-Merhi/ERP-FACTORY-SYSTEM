import { describe, expect, it } from "vitest";
import {
  HADI_HISTORICAL_ACCRUAL_GUARD,
  classifyHadiRentDifference,
  isHadiHistoricAccrualRepair,
  isHadiProtectedRentMonth,
  isFutureHadiLinkedRentMonth,
  positiveRentalDue,
} from "../server/services/rental/hadiRentLedgerPolicy";
import {
  isHadiDuplicateLinkedRentExpenseJournal,
} from "../server/services/rental/hadiRentLedgerPolicy";

describe("HADI L'SHI Phase 3: protect verified historic rent", () => {
  it("blocks both historical re-accrue and accrual reversal only for HADI ERP", () => {
    expect(isHadiHistoricAccrualRepair(1, "ERP")).toBe(true);
    expect(isHadiHistoricAccrualRepair(1, "PROPERTIES")).toBe(false);
    expect(isHadiHistoricAccrualRepair(8, "ERP")).toBe(false);
    expect(isHadiProtectedRentMonth(1, "ERP", 2026, 11)).toBe(true);
    expect(isHadiProtectedRentMonth(1, "ERP", 2026, 12)).toBe(false);
    expect(isHadiProtectedRentMonth(8, "ERP", 2026, 7)).toBe(false);
    expect(HADI_HISTORICAL_ACCRUAL_GUARD.code).toBe("HADI_RENT_HISTORICAL_REPAIR_LOCKED");
  });

  it("matches HADI's verified $18,000 accrued liability to its $18,000 linked rent", () => {
    expect(classifyHadiRentDifference("18000", "18000", "0", 0))
      .toEqual({ difference: "0.00", status: "MATCH" });
  });

  it("protects the old months and enables only future HADI linked rent accrual", () => {
    expect(isFutureHadiLinkedRentMonth(1, "ERP", true, 2026, 11)).toBe(false);
    expect(isFutureHadiLinkedRentMonth(1, "ERP", true, 2026, 12)).toBe(true);
    expect(isFutureHadiLinkedRentMonth(1, "ERP", true, 2027, 1)).toBe(true);
    expect(isFutureHadiLinkedRentMonth(1, "ERP", false, 2026, 12)).toBe(false);
    expect(isFutureHadiLinkedRentMonth(13, "PROPERTIES", true, 2026, 12)).toBe(false);
    expect(isFutureHadiLinkedRentMonth(8, "ERP", true, 2026, 12)).toBe(false);
    expect(isFutureHadiLinkedRentMonth(1, "ERP", true, 2026, 0)).toBe(false);
  });

  it("flags a linked Properties rent receipt that was not cleared from HADI payable", () => {
    expect(classifyHadiRentDifference("18000", "0", "0", 0))
      .toEqual({ difference: "18000.00", status: "REVIEW" });
  });

  it("flags overcleared HADI payable, including a $2,000 historical mismatch", () => {
    expect(classifyHadiRentDifference("16000", "18000", "0", 0))
      .toEqual({ difference: "-2000.00", status: "REVIEW" });
  });

  it("includes normal unpaid HADI-owned shops rather than mistaking them for linked rent", () => {
    expect(classifyHadiRentDifference("22200", "18000", "4200", 0))
      .toEqual({ difference: "0.00", status: "MATCH" });
  });

  it("flags a POSTED payment without its original live voucher even if totals match", () => {
    expect(classifyHadiRentDifference("18000", "18000", "0", 1))
      .toEqual({ difference: "0.00", status: "REVIEW" });
  });

  it("never nets an advance at one lease against another tenant's unpaid rent", () => {
    expect(positiveRentalDue("5000", "6500").toFixed(2)).toBe("0.00");
    expect(positiveRentalDue("5000", "3000").toFixed(2)).toBe("2000.00");
  });
});

describe("HADI L'SHI Phase 3: double expense write refusal", () => {
  it("blocks the original bad journal pattern Dr #1007 / Cr owner credit #867", () => {
    expect(isHadiDuplicateLinkedRentExpenseJournal(1, "Journal", [
      { ledgerAccountId: 1007, debitAmount: "18000", creditAmount: "0" },
      { ledgerAccountId: 867, debitAmount: "0", creditAmount: "18000" },
    ])).toBe(true);
  });

  it("blocks Dr #1007 / Cr transfer account #1197, including blank narration", () => {
    expect(isHadiDuplicateLinkedRentExpenseJournal(1, "Journal", [
      { ledgerAccountId: 1007, debitAmount: "18000" },
      { ledgerAccountId: 1197, creditAmount: "18000" },
    ])).toBe(true);
  });

  it("allows a regular monthly accrual Dr expense / Cr accrued payable", () => {
    expect(isHadiDuplicateLinkedRentExpenseJournal(1, "Journal", [
      { ledgerAccountId: 1007, debitAmount: "18000" },
      { ledgerAccountId: 1021, creditAmount: "18000" },
    ])).toBe(false);
  });

  it("allows a valid linked-rent settlement Dr accrued payable / Cr owner credit", () => {
    expect(isHadiDuplicateLinkedRentExpenseJournal(1, "Journal", [
      { ledgerAccountId: 1021, debitAmount: "18000" },
      { ledgerAccountId: 867, creditAmount: "18000" },
    ])).toBe(false);
  });

  it("never changes the generic treatment of another company's journals", () => {
    expect(isHadiDuplicateLinkedRentExpenseJournal(13, "Journal", [
      { ledgerAccountId: 1007, debitAmount: "18000" },
      { ledgerAccountId: 867, creditAmount: "18000" },
    ])).toBe(false);
  });

  it("does not interfere with cash rent Payment vouchers or prepaid recognition", () => {
    expect(isHadiDuplicateLinkedRentExpenseJournal(1, "Payment", [
      { ledgerAccountId: 1007, debitAmount: "18000" },
      { ledgerAccountId: 867, creditAmount: "18000" },
    ])).toBe(false);
    expect(isHadiDuplicateLinkedRentExpenseJournal(1, "Journal", [
      { ledgerAccountId: 1007, debitAmount: "3500" },
      { ledgerAccountId: 1022, creditAmount: "3500" },
    ])).toBe(false);
  });
});
