import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await import("../server/runtime/apiPagination.mjs");
});

describe("P2 compact API response profiles", () => {
  it("returns only worker bale-history fields requested by the detail page", async () => {
    const app = express();
    app.get("/api/factory/workers/:id/bales", (_req, res) => {
      res.json([
        {
          id: 1,
          workerId: 99,
          baleCode: "B-1",
          productName: "Shirts",
          weightKg: "42.500",
          totalCost: "11.25",
          status: "FINALIZED",
          finalizedAt: "2026-08-28T10:00:00.000Z",
          internalNotes: "not needed by the history table",
        },
      ]);
    });

    const response = await request(app).get("/api/factory/workers/99/bales?profile=worker-bales-summary").expect(200);

    expect(response.body).toEqual([
      {
        id: 1,
        baleCode: "B-1",
        productName: "Shirts",
        weightKg: "42.500",
        totalCost: "11.25",
        status: "FINALIZED",
        finalizedAt: "2026-08-28T10:00:00.000Z",
      },
    ]);
  });

  it("keeps only ledger picker fields", async () => {
    const app = express();
    app.get("/api/ledger-accounts", (_req, res) => {
      res.json([
        {
          id: 7,
          companyId: 1,
          code: "CASH-1",
          name: "Main Cash",
          accountType: "Cash",
          subType: "Cash",
          parentId: null,
          openingBalance: "1250.00",
          openingBalanceHistoricalRate: "1.0000000000",
          active: true,
          isHidden: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
    });

    const response = await request(app).get("/api/ledger-accounts?profile=picker").expect(200);

    expect(response.body).toEqual([
      {
        id: 7,
        code: "CASH-1",
        name: "Main Cash",
        accountType: "Cash",
        subType: "Cash",
        parentId: null,
        active: true,
        isHidden: false,
      },
    ]);
  });

  it("removes transport-only metadata from Location Inventory view rows", async () => {
    const app = express();
    app.get("/api/locations/:id/inventory", (_req, res) => {
      res.json([
        {
          inventoryId: 11,
          locationId: 5,
          stockItemId: 22,
          quantity: "10",
          averageRate: "2.50",
          totalValue: "25.00",
          stockItemCode: "ITEM-22",
          stockItemName: "Item 22",
          stockItemUom: "PCS",
          stockGroupId: 2,
          stockGroupName: "Group 2",
          stockGroupCode: "G2",
          stockItemActive: true,
          categoryId: 4,
          categoryName: "Category 4",
          lastUpdated: "2026-08-28T10:00:00.000Z",
          barcode: null,
          lastSellingPrice: "4.00",
        },
      ]);
    });

    const response = await request(app).get("/api/locations/5/inventory?profile=view").expect(200);

    expect(response.body[0]).toEqual({
      inventoryId: 11,
      locationId: 5,
      stockItemId: 22,
      quantity: "10",
      averageRate: "2.50",
      totalValue: "25.00",
      stockItemCode: "ITEM-22",
      stockItemName: "Item 22",
      stockItemUom: "PCS",
      stockGroupId: 2,
      stockGroupName: "Group 2",
      stockGroupCode: "G2",
      stockItemActive: true,
      categoryId: 4,
      categoryName: "Category 4",
    });
    expect(response.body[0]).not.toHaveProperty("lastUpdated");
    expect(response.body[0]).not.toHaveProperty("barcode");
    expect(response.body[0]).not.toHaveProperty("lastSellingPrice");
  });

  it("filters Analytics account payloads to the entity types and fields the page renders", async () => {
    const app = express();
    app.get("/api/accounts/all", (_req, res) => {
      res.json({
        asOfDate: "2026-08-28",
        accounts: [
          {
            id: "ledger-1",
            accountId: 1,
            type: "ledger",
            code: "1000",
            name: "Cash",
            accountType: "Cash",
            subType: null,
            balance: 100,
            balanceSide: "Dr",
            parentId: null,
            openingBalance: 50,
            active: true,
          },
          { id: "supplier-2", accountId: 2, type: "supplier", code: "SUP-2", name: "Supplier", balance: 10 },
          { id: "employee-3", accountId: 3, type: "employee", code: "EMP-3", name: "Employee", balance: 20 },
          {
            id: "bank-4",
            accountId: 4,
            type: "bank",
            code: "BANK-4",
            name: "Bank",
            accountType: "Bank",
            balance: 30,
            balanceSide: "Dr",
          },
          {
            id: "fixedAsset-5",
            accountId: 5,
            type: "fixedAsset",
            code: "FA-5",
            name: "Truck",
            accountType: "Fixed Asset",
            balance: 40,
            balanceSide: "Dr",
          },
        ],
      });
    });

    const response = await request(app).get("/api/accounts/all?profile=analytics").expect(200);

    expect(response.body.asOfDate).toBe("2026-08-28");
    expect(response.body.accounts.map((account: { type: string }) => account.type)).toEqual([
      "ledger",
      "bank",
      "fixedAsset",
    ]);
    expect(response.body.accounts[0]).not.toHaveProperty("openingBalance");
    expect(response.body.accounts[0]).not.toHaveProperty("active");
  });
});
