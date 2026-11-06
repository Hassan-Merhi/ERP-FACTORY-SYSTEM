import { describe, expect, it } from "vitest";
import { buildAccountStatementTabUrl } from "../client/src/pages/accountslegacy/accountStatementNavigation";

describe("Accounts statement navigation in a new tab", () => {
  it.each([
    ["/accounts", "ERP"],
    ["/factory/accounts", "Factory"],
    ["/properties/accounts", "Properties"],
  ])("retains the %s company-type route (%s)", (route) => {
    expect(
      buildAccountStatementTabUrl(
        `https://erp.example.test${route}?view=compact`,
        { accountId: 386, type: "ledger" },
        { fromDate: "", toDate: "" },
      ),
    ).toBe(`${route}?view=compact&accountId=386&accountType=ledger`);
  });

  it("keeps unrelated search params and carries the selected statement dates", () => {
    expect(
      buildAccountStatementTabUrl(
        "https://erp.example.test/factory/accounts?accountId=11&accountType=bank&view=condensed",
        { accountId: 22, type: "employee" },
        { fromDate: "2026-10-01", toDate: "2026-10-31" },
      ),
    ).toBe(
      "/factory/accounts?accountId=22&accountType=employee&view=condensed&startDate=2026-10-01&endDate=2026-10-31",
    );
  });

  it("drops stale date parameters when the overview is on all time", () => {
    expect(
      buildAccountStatementTabUrl(
        "https://erp.example.test/properties/accounts?startDate=2025-01-01&endDate=2025-12-31",
        { accountId: 1007, type: "ledger" },
        { fromDate: "", toDate: "" },
      ),
    ).toBe("/properties/accounts?accountId=1007&accountType=ledger");
  });
});
