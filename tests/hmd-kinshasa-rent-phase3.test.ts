import { describe, expect, it } from "vitest";
import {
  isRentMonthReadyToRecognize,
  isRentRecognitionHeld,
  RENT_RECOGNITION_HOLD_PREFIX,
} from "../server/services/rental/rentRecognitionHold";

describe("HMD KINSHASA historical rent reconciliation holds (Phase 3)", () => {
  const directExpenseSettled =
    RENT_RECOGNITION_HOLD_PREFIX +
    " Jan-May 2026 directly expensed in original posted rent payment vouchers; deleted accrual #8534";

  it("recognizes the persisted historical hold as an explicit no-reaccrue marker", () => {
    expect(isRentRecognitionHeld(directExpenseSettled)).toBe(true);
    expect(isRentMonthReadyToRecognize(directExpenseSettled, true)).toBe(false);
    expect(isRentMonthReadyToRecognize(directExpenseSettled, false)).toBe(false);
  });

  it("still allows a later legitimately due rental month to be accrued", () => {
    const rows = [
      { month: "2026-01", notes: directExpenseSettled, due: true },
      { month: "2026-05", notes: directExpenseSettled, due: true },
      { month: "2026-12", notes: null, due: true },
      { month: "2027-01", notes: null, due: false },
    ];
    expect(rows.filter((row) => isRentMonthReadyToRecognize(row.notes, row.due)).map((r) => r.month))
      .toEqual(["2026-12"]);
  });

  it("does not suppress an ordinary unpaid month without an explicit hold", () => {
    expect(isRentMonthReadyToRecognize(null, true)).toBe(true);
    expect(isRentMonthReadyToRecognize("Paid 2026-11", true)).toBe(true);
    expect(isRentMonthReadyToRecognize(null, false)).toBe(false);
    expect(isRentRecognitionHeld("mentioned " + RENT_RECOGNITION_HOLD_PREFIX)).toBe(false);
  });
});
