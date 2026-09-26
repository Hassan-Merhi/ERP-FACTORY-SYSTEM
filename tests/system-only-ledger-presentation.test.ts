import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerGoldenCoastSystemAccountPresentation } from "../server/routes/goldenCoastSystemAccountPresentation";

describe("system-only ledger account presentation", () => {
  it("hides account migration clearing from Factory analytics account responses", async () => {
    const app = express();
    registerGoldenCoastSystemAccountPresentation(app);

    app.get("/api/factory/analytics/accounts", (_req, res) => {
      res.json({
        accounts: [
          {
            id: "ledger-1",
            type: "ledger",
            code: "AM-TO-1",
            name: "Account Migration Clearing - HADI L’SHI",
            accountType: "Asset",
            subType: "account_migration_clearing",
            balance: "800000.00",
            balanceSide: "Cr",
          },
          {
            id: "ledger-2",
            type: "ledger",
            code: "PREPAID-RENT",
            name: "Prepaid Rent",
            accountType: "Asset",
            subType: null,
            balance: "31283.33",
            balanceSide: "Dr",
          },
        ],
      });
    });

    const response = await request(app).get("/api/factory/analytics/accounts").expect(200);

    expect(response.body.accounts).toHaveLength(1);
    expect(response.body.accounts[0].name).toBe("Prepaid Rent");
    expect(response.body.accounts.some((account: { subType?: string }) => account.subType === "account_migration_clearing")).toBe(false);
  });
});
