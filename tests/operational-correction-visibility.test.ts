import { describe, expect, it } from "vitest";
import {
  ROUTINE_CORRECTION_COMPANY_ID,
  ROUTINE_CORRECTION_VOUCHER_ID,
  filterRoutineCorrection,
  keepRoutineVoucher,
} from "../server/services/accounting/operationalCorrectionVisibility";

describe("operational correction browsing filter", () => {
  const correction = { id: ROUTINE_CORRECTION_VOUCHER_ID, companyId: ROUTINE_CORRECTION_COMPANY_ID };

  it("shows the correction to Developer in routine lists", () => {
    expect(filterRoutineCorrection(8, "Developer")).toBe(false);
    expect(keepRoutineVoucher(correction, "Developer")).toBe(true);
  });

  it("filters only the specified correction for non-developer HMD Kinshasa lists", () => {
    for (const role of ["Admin", "Owner", "Manager", "POS", undefined, null]) {
      expect(filterRoutineCorrection(8, role)).toBe(true);
      expect(keepRoutineVoucher(correction, role)).toBe(false);
      expect(keepRoutineVoucher({ id: 12869, companyId: 8 }, role)).toBe(true);
    }
  });

  it("does not affect other companies", () => {
    expect(filterRoutineCorrection(1, "Owner")).toBe(false);
    expect(keepRoutineVoucher({ id: ROUTINE_CORRECTION_VOUCHER_ID, companyId: 1 }, "Owner")).toBe(true);
  });
});
