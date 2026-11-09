import { describe, expect, it } from "vitest";
import {
  RENT_RECOGNITION_HOLD_PREFIX,
  isRentRecognitionHeld,
} from "../server/services/rental/rentRecognitionHold";

describe("reviewed rental month accounting holds", () => {
  it("recognizes only an explicit review marker", () => {
    expect(isRentRecognitionHeld(null)).toBe(false);
    expect(isRentRecognitionHeld(undefined)).toBe(false);
    expect(isRentRecognitionHeld("ordinary rental note")).toBe(false);
    expect(isRentRecognitionHeld("mentioned " + RENT_RECOGNITION_HOLD_PREFIX)).toBe(false);
    expect(isRentRecognitionHeld(RENT_RECOGNITION_HOLD_PREFIX + " Company 12 November 2026")).toBe(true);
  });

  it("requires the persisted review note rather than a hardcoded company or month ID", () => {
    expect(isRentRecognitionHeld(null)).toBe(false);
    expect(isRentRecognitionHeld(RENT_RECOGNITION_HOLD_PREFIX + " Warehouse 5001")).toBe(true);
    expect(isRentRecognitionHeld("ordinary month without review marker")).toBe(false);
  });

  it("does not infer a hold from an amount or prepaid flag", () => {
    expect(isRentRecognitionHeld("Paid USD 1416.67, used prepaid account")).toBe(false);
  });
});
