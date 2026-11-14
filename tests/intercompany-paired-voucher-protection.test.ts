import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INTERCOMPANY_PAIRED_VOUCHER_LOCK_MESSAGE,
  isIntercompanyPairedVoucher,
  voucherMutationBlockReason,
} from "../server/lib/migratedVoucherGuard";
import { buildExactVoucherReversal } from "../server/services/accounting/voucherReversal";

const original = (sourceModule: string) => ({
  voucher: {
    id: 77,
    companyId: 20,
    voucherType: "Payment",
    voucherNumber: "PAY-77",
    totalAmount: "100.00",
    currency: "USD",
    sourceModule,
  },
  entries: [
    { ledgerAccountId: 11, debitAmount: "100.00", creditAmount: "0.00" },
    { ledgerAccountId: 12, debitAmount: "0.00", creditAmount: "100.00" },
  ],
});

describe("paired intercompany vouchers remain immutable outside the coordinated reversal", () => {
  it("marks both linked cash and trade vouchers as globally mutation-protected", () => {
    expect(isIntercompanyPairedVoucher({ sourceModule: "INTERCOMPANY_CONTAINER" })).toBe(true);
    expect(voucherMutationBlockReason({ sourceModule: "INTERCOMPANY_CONTAINER" })).toBe(
      INTERCOMPANY_PAIRED_VOUCHER_LOCK_MESSAGE
    );
    expect(isIntercompanyPairedVoucher({ sourceModule: "MANUAL" })).toBe(false);
    expect(voucherMutationBlockReason({ sourceModule: "MANUAL" })).toBeNull();
  });

  it("refuses any exact reversal constructed from a single intercompany leg", () => {
    expect(() =>
      buildExactVoucherReversal({
        companyId: 20,
        originalVoucherId: 77,
        original: original("INTERCOMPANY_CONTAINER"),
        reversalVoucherNumber: "REV-77",
        reversalDate: "2026-11-13",
      })
    ).toThrow(INTERCOMPANY_PAIRED_VOUCHER_LOCK_MESSAGE);
  });

  it("does not prevent ordinary unrelated Payment reversal construction", () => {
    const reversed = buildExactVoucherReversal({
      companyId: 20,
      originalVoucherId: 77,
      original: original("MANUAL"),
      reversalVoucherNumber: "REV-77",
      reversalDate: "2026-11-13",
    });
    expect(reversed.voucher.sourceModule).toBe("MANUAL");
    expect(reversed.entries).toHaveLength(2);
    expect(reversed.entries[0].creditAmount).toBe("100.00");
  });

  it("routes both generic editing and generic reversing through independent paired-voucher locks", () => {
    const corrections = readFileSync("server/services/accounting/voucherCorrection.ts", "utf8");
    const reversals = readFileSync("server/services/accounting/voucherReversal.ts", "utf8");
    expect(corrections.match(/isIntercompanyPairedVoucher\((?:voucher|original)\)/g)).toHaveLength(2);
    expect(reversals).toContain("if (original && isIntercompanyPairedVoucher(original))");
    expect(reversals).toContain('PostingValidationError("IC_VOUCHER_IMMUTABLE"');
  });
});
