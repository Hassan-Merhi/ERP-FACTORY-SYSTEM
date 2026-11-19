import { describe, expect, it } from "vitest";
import { destinationContainerGitPostingLines } from "../server/services/intercompany/containerDestinationPosting";

describe("Phase 2 destination Properties supplier liability", () => {
  it("books confirmed landed cost to destination GIT and the Properties supplier once", () => {
    const lines = destinationContainerGitPostingLines({
      goodsInTransitLedgerAccountId: 501,
      propertiesSupplierId: 820,
      confirmedLandedCost: "10500.00",
      sourceCompanyName: "Hassan Properties",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      ledgerAccountId: 501,
      debit: "10500.00",
    });
    expect(lines[1]).toMatchObject({
      supplierId: 820,
      credit: "10500.00",
    });
    expect(lines[0].supplierId).toBeUndefined();
    expect(lines[1].ledgerAccountId).toBeUndefined();
    expect(lines.map((line) => ("ledgerAccountId" in line ? "ledger" : "supplier"))).toEqual(["ledger", "supplier"]);
  });

  it("refuses missing mapped GIT and supplier identifiers", () => {
    const make = (goodsInTransitLedgerAccountId: number, propertiesSupplierId: number) =>
      destinationContainerGitPostingLines({
        goodsInTransitLedgerAccountId,
        propertiesSupplierId,
        confirmedLandedCost: "100.00",
        sourceCompanyName: "Hassan Properties",
      });
    expect(() => make(0, 820)).toThrow("Destination GIT account");
    expect(() => make(501, 0)).toThrow("Destination Properties supplier");
  });
});
