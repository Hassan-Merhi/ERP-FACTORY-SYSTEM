import { describe, expect, it } from "vitest";
import { isCrossCompanyReferenceRead } from "../server/middleware/tenantIsolationBoundary";

describe("Wave 1 cross-company reference policy", () => {
  it("allows only GET reference reads for locations and ledger accounts", () => {
    expect(isCrossCompanyReferenceRead("GET", "/api/locations")).toBe(true);
    expect(isCrossCompanyReferenceRead("GET", "/api/ledger-accounts")).toBe(true);

    expect(isCrossCompanyReferenceRead("POST", "/api/locations")).toBe(false);
    expect(isCrossCompanyReferenceRead("PUT", "/api/ledger-accounts")).toBe(false);
    expect(isCrossCompanyReferenceRead("GET", "/api/vouchers")).toBe(false);
    expect(isCrossCompanyReferenceRead("GET", "/api/payroll/bonus-locations")).toBe(false);
  });
});
