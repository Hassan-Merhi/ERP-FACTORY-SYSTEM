import { describe, expect, it } from "vitest";
import { resolveBonusSalesCompanyId } from "../server/routes/erp-payroll/bonuses";

/**
 * GC-LSHI posts its sales against a location row owned by another company, so
 * resolving the "% of sales" bonus from the location's owner totalled the wrong
 * company's sales — and, when the owner had no sales in the period, produced a
 * zero bonus.
 */
describe("resolveBonusSalesCompanyId", () => {
  it("uses the company the picker paired with the location", () => {
    expect(
      resolveBonusSalesCompanyId({
        explicitSourceCompanyId: 10,
        sessionCompanyId: 4,
        locationOwnerCompanyId: 4,
        sessionCompanyHasSales: true,
      })
    ).toBe(10);
  });

  it("prefers the active company over the location owner when it sells there", () => {
    expect(
      resolveBonusSalesCompanyId({
        explicitSourceCompanyId: null,
        sessionCompanyId: 10,
        locationOwnerCompanyId: 4,
        sessionCompanyHasSales: true,
      })
    ).toBe(10);
  });

  it("falls back to the location owner when the active company has no sales there", () => {
    expect(
      resolveBonusSalesCompanyId({
        explicitSourceCompanyId: null,
        sessionCompanyId: 10,
        locationOwnerCompanyId: 4,
        sessionCompanyHasSales: false,
      })
    ).toBe(4);
  });

  it("keeps the active company when the location has no usable owner", () => {
    expect(
      resolveBonusSalesCompanyId({
        explicitSourceCompanyId: 0,
        sessionCompanyId: 10,
        locationOwnerCompanyId: null,
        sessionCompanyHasSales: false,
      })
    ).toBe(10);
  });
});
