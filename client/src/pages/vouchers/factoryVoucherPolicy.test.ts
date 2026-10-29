import { describe, expect, it } from "vitest";
import { shouldShowFactoryVoucherTab } from "./factoryVoucherPolicy";

describe("factory voucher tab policy", () => {
  it.each(["transfer", "transferorder", "adjustment", "creditnote"])(
    "always hides %s even when a user has no hidden permissions",
    (tab) => {
      expect(shouldShowFactoryVoucherTab(tab, [], "hide_tab_vouchers_" + tab)).toBe(false);
      expect(shouldShowFactoryVoucherTab(tab, ["hide_tab_vouchers_payment"], "hide_tab_vouchers_" + tab)).toBe(false);
    },
  );

  it.each(["payment", "receipt", "journal"])("keeps %s available unless separately hidden", (tab) => {
    const key = "hide_tab_vouchers_" + tab;
    expect(shouldShowFactoryVoucherTab(tab, [], key)).toBe(true);
    expect(shouldShowFactoryVoucherTab(tab, [key], key)).toBe(false);
  });
});
