import { describe, expect, it } from "vitest";
import { appendRentalTenantName } from "../server/services/rental/rentalVoucherTenantDescription";

describe("Properties rental voucher tenant narration", () => {
  it("adds the tenant to rent receipts and payments", () => {
    expect(appendRentalTenantName("Rent paid - HMD LUBUMBASHI/LSHI #2 - 10/2027", "Hassan Dakik"))
      .toBe("Rent paid - HMD LUBUMBASHI/LSHI #2 - 10/2027 - Tenant: Hassan Dakik");
  });
  it("preserves an existing tenant label on repeated reads", () => {
    const narration = "Guarantee deposit - A/1 - Tenant: Acme";
    expect(appendRentalTenantName(narration, " acme ")).toBe(narration);
  });
  it("leaves unrelated vouchers unchanged without a tenant", () => {
    expect(appendRentalTenantName("Manual payment", null)).toBe("Manual payment");
    expect(appendRentalTenantName(null, null)).toBeNull();
  });
});
