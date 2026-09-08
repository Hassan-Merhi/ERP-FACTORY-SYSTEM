import { describe, expect, it } from "vitest";
import { intercompanyApprovalMessage, parseIntercompanyApproval } from "./intercompanyApproval";

describe("parseIntercompanyApproval", () => {
  it("reads the voucher number out of the approve endpoint's payload", () => {
    const result = parseIntercompanyApproval({ success: true, voucherId: 12, voucherNumber: "JV-0042" });
    expect(result.voucherNumber).toBe("JV-0042");
    expect(intercompanyApprovalMessage(result)).toBe("Mirror voucher JV-0042 created.");
  });

  it("does not report a voucher number when the payload carries none", () => {
    // Regression: the approval toast used to read `voucherNumber` off the
    // unparsed fetch Response, which is always undefined, and rendered
    // "Mirror voucher undefined created."
    for (const payload of [new Response(), {}, null, "JV-1", { voucherNumber: "" }, { voucherNumber: 42 }]) {
      const result = parseIntercompanyApproval(payload);
      expect(result.voucherNumber).toBeNull();
      expect(intercompanyApprovalMessage(result)).toBe("Mirror voucher created.");
      expect(intercompanyApprovalMessage(result)).not.toContain("undefined");
    }
  });
});
