import { describe, expect, it } from "vitest";

import {
  ACTION_INTENTS,
  TOOL_INTENTS,
  buildActionSystemPrompt,
  buildGeneralSystemPrompt,
  buildSystemPrompt,
  buildToolSystemPrompt,
  classifyChatIntent,
  generateQuickSuggestions,
} from "../server/chat/prompts";
import type { ERPContext } from "../server/chat/erpContext";

function makeContext(overrides: Record<string, unknown> = {}): ERPContext {
  return {
    dataFetchedAt: "2026-09-15T10:30:00.000Z",
    inventory: [],
    locations: [],
    inventoryValueByLocation: [],
    stockItems: [],
    suppliers: [],
    customers: [],
    todaysSales: {
      date: "2026-09-15",
      revenue: 0,
      cost: 0,
      profit: 0,
      margin: 0,
      transactionCount: 0,
      unitsSold: 0,
    },
    thisMonthSales: {
      monthStart: "2026-09-01",
      revenue: 0,
      cost: 0,
      profit: 0,
      margin: 0,
      transactionCount: 0,
      unitsSold: 0,
    },
    profitAnalysis: {
      totalSales: "0",
      totalCost: "0",
      totalProfit: "0",
      itemsSold: 0,
    },
    financialSummary: {
      totalPayables: 0,
      totalReceivables: 0,
      openPurchaseOrders: 0,
      pendingContainerSales: 0,
    },
    lowStockAlerts: [],
    supplierBalances: [],
    slowMovingStock: [],
    itemsToMarkdown: [],
    overdueContainers: [],
    containersInTransit: [],
    employeeBalances: [],
    topSellingItems: [],
    salesByGroupToday: [],
    salesByGroupThisMonth: [],
    salesByGroup: [],
    itemProfitabilityReport: [],
    pricingHealthReport: [],
    recentTransactions: [],
    purchaseOrders: [],
    stockItemsWithInventory: [],
    recentSalesHistory: [],
    ...overrides,
  } as unknown as ERPContext;
}

function richContext(): ERPContext {
  return makeContext({
    inventory: [{ id: 1 }],
    locations: [{ id: 1, name: "Main" }],
    inventoryValueByLocation: [{ locationId: 1, locationName: "Main", totalValue: 1250, itemCount: 2 }],
    stockItems: [{ id: 1 }],
    suppliers: [
      {
        id: 1,
        code: "SUP-1",
        legalName: "Supplier One",
        phone: "123",
        email: "s@example.com",
      },
    ],
    customers: [{ id: 1, code: "CUS-1", legalName: "Customer One", phone: "456" }],
    profitAnalysis: {
      totalSales: "15000",
      totalCost: "9000",
      totalProfit: "6000",
      itemsSold: 120,
    },
    lowStockAlerts: [
      {
        itemName: "Low Item",
        itemCode: "LOW",
        currentQty: 2,
        reorderLevel: 5,
        status: "LOW",
      },
    ],
    supplierBalances: [
      {
        supplierName: "Supplier One",
        supplierCode: "SUP-1",
        balance: 2500,
        status: "Payable",
      },
    ],
    slowMovingStock: [
      {
        itemName: "Slow Item",
        itemCode: "SLOW",
        quantity: 12,
        value: 800,
        recommendation: "Consider promotion",
      },
    ],
    itemsToMarkdown: [{ itemName: "Markdown Item", value: 500 }],
    overdueContainers: [
      {
        poNumber: "PO-1",
        supplierName: "Supplier One",
        amount: 5000,
        daysInTransit: 100,
      },
    ],
    containersInTransit: [
      {
        poNumber: "PO-2",
        supplierName: "Supplier One",
        amount: 4000,
        daysInTransit: 20,
        isOverdue: false,
      },
    ],
    employeeBalances: [{ employeeName: "Worker One", employeeCode: "E1", balance: 150 }],
    topSellingItems: [
      {
        itemName: "Top Item",
        totalRevenue: "5000",
        totalProfit: "1800",
        profitMargin: "36%",
      },
    ],
    salesByGroupToday: [
      {
        groupCode: "G1",
        groupName: "Group One",
        totalQty: 4,
        totalRevenue: 600,
        totalProfit: 200,
        profitMargin: "33%",
        isLosing: false,
      },
    ],
    salesByGroupThisMonth: [
      {
        groupCode: "G1",
        groupName: "Group One",
        totalQty: 40,
        totalRevenue: 6000,
        totalProfit: 2200,
        profitMargin: "36%",
        isLosing: false,
      },
    ],
    salesByGroup: [
      {
        groupCode: "G2",
        groupName: "Loss Group",
        totalQty: 2,
        totalRevenue: 100,
        totalProfit: -20,
        profitMargin: "-20%",
        isLosing: true,
      },
    ],
    itemProfitabilityReport: [
      {
        itemCode: "LOSS",
        itemName: "Loss Item",
        totalQty: 2,
        totalRevenue: 100,
        totalCost: 120,
        totalProfit: -20,
        profitMargin: "-20%",
        avgConfiguredPrice: 50,
        avgCostPrice: 60,
        isLosing: true,
      },
      {
        itemCode: "WIN",
        itemName: "Win Item",
        totalQty: 5,
        totalRevenue: 500,
        totalCost: 250,
        totalProfit: 250,
        profitMargin: "50%",
        avgConfiguredPrice: 100,
        avgCostPrice: 50,
        isLosing: false,
      },
    ],
    pricingHealthReport: [
      {
        itemCode: "LOSS",
        itemName: "Loss Item",
        sellingPrice: 50,
        avgCostPrice: 60,
        priceGap: "-10",
        stockQty: 10,
        status: "LOSING",
        potentialLoss: 100,
      },
    ],
    recentTransactions: [
      {
        type: "Sale",
        number: "V-1",
        amount: "100",
        date: "2026-09-15",
        description: "Test",
      },
    ],
    purchaseOrders: [{ poNumber: "PO-1", itemsTotal: "5000", status: "Open" }],
    stockItemsWithInventory: [
      {
        id: 1,
        code: "A",
        name: "Item A",
        groupName: "Group One",
        totalQuantity: 10,
        totalValue: 500,
        locations: [{ locationName: "Main", quantity: 10, averageRate: 50 }],
      },
    ],
    recentSalesHistory: [
      {
        date: "2026-09-15",
        voucherNumber: "V-1",
        itemCode: "A",
        itemName: "Item A",
        locationName: "Main",
        quantity: 2,
        sellingPrice: 70,
        profit: 40,
      },
    ],
  });
}

describe("Phase 33 chat prompt behavior", () => {
  it("covers populated and empty full-ERP prompt branches", () => {
    const populated = buildSystemPrompt(richContext(), {
      currency: "USD",
    } as never);
    expect(populated).toContain("LOW STOCK ITEMS");
    expect(populated).toContain("SIGNIFICANT SUPPLIER BALANCES");
    expect(populated).toContain("SLOW-MOVING STOCK");
    expect(populated).toContain("ITEMS TO CONSIDER FOR MARKDOWN");
    expect(populated).toContain("OVERDUE CONTAINERS");
    expect(populated).toContain("EMPLOYEE BALANCES");
    expect(populated).toContain("Loss Item");

    const empty = buildSystemPrompt(makeContext());
    expect(empty).toContain("No low stock alerts at this time.");
    expect(empty).toContain("No containers currently in transit.");
    expect(empty).toContain("No sales data available yet.");
    expect(empty).toContain("No pricing data available.");
  });

  it("covers quick-suggestion priority and fallback branches", () => {
    const suggestions = generateQuickSuggestions(richContext());
    expect(suggestions).toHaveLength(6);
    expect(suggestions[0]).toContain("overdue");

    expect(generateQuickSuggestions(makeContext())).toEqual([
      "Give me a summary of today's business",
      "Which items have the highest profit margin?",
      "How is my inventory distributed across locations?",
    ]);
  });

  it.each([
    ["edit server/routes/orders.ts", "code_edit"],
    ["read server/routes/orders.ts", "code_read"],
    ["adjust stock by 4 units", "create_stock_adjustment"],
    ["create a new stock item called Blue Bale", "create_stock_item"],
    ["transfer stock item A from Main to Store", "create_stock_transfer"],
    ["find voucher 1042", "search_voucher"],
    ["show account balance for cash", "account_query"],
    ["update selling price for item A", "price_update"],
    ["download excel template", "excel_import"],
    ["give me a monthly business summary", "business_summary"],
    ["show sales revenue and profit", "sales_query"],
    ["how much inventory is in stock", "inventory_query"],
    ["show supplier balances", "supplier_query"],
    ["show customer outstanding balances", "customer_query"],
    ["hello", "general_knowledge"],
  ])("classifies %s as %s", (message, expected) => {
    expect(classifyChatIntent(message)).toBe(expected);
  });

  it("covers general and action prompt branches", () => {
    expect(buildGeneralSystemPrompt()).toContain("powerful AI assistant");

    const intents = [
      "create_voucher",
      "create_stock_adjustment",
      "create_stock_transfer",
      "create_stock_item",
      "price_update",
      "search_voucher",
      "account_query",
      "excel_import",
      "general",
    ] as const;

    for (const intent of intents) {
      const prompt = buildActionSystemPrompt(intent as never, {
        currentRoute: "/daybook",
      });
      expect(prompt).toContain("/daybook");
      expect(prompt.length).toBeGreaterThan(100);
    }

    expect(ACTION_INTENTS.has("create_voucher")).toBe(true);
    expect(TOOL_INTENTS.has("inventory_query")).toBe(true);
  });

  it("covers focused inventory, supplier, and customer prompts", () => {
    const inventory = buildToolSystemPrompt(
      "inventory_query",
      {
        items: [
          {
            id: 1,
            name: "Item A",
            code: "A",
            totalQty: 10,
            sellingPrice: 20,
            avgCost: 12,
            totalValue: 120,
            pricingStatus: "PROFITABLE",
          },
        ],
        lowStock: [
          {
            id: 2,
            name: "Low",
            code: "L",
            qty: 1,
            reorderLevel: 5,
            status: "LOW",
          },
        ],
        locationBreakdown: [{ location: "Main", quantity: 10, avgCost: 12, totalValue: 120 }],
      } as never,
      { currentRoute: "/stock" }
    );
    expect(inventory).toContain("LOCATION BREAKDOWN");
    expect(inventory).toContain("LOW STOCK ALERTS");

    const supplier = buildToolSystemPrompt("supplier_query", {
      suppliers: [
        {
          id: 1,
          name: "Supplier One",
          code: "S1",
          phone: null,
          email: null,
          openingBalance: "0",
        },
      ],
      supplierBalances: [
        {
          supplierName: "Supplier One",
          supplierCode: "S1",
          balance: 100,
          status: "Payable",
        },
      ],
    } as never);
    expect(supplier).toContain("SUPPLIER BALANCES");

    const customer = buildToolSystemPrompt("customer_query", {
      customers: [{ id: 1, name: "Customer One", code: "C1", phone: null }],
    } as never);
    expect(customer).toContain("CUSTOMER DATA");
  });

  it("covers focused sales and business-summary prompts", () => {
    const summary = {
      today: {
        date: "2026-09-15",
        revenue: 100,
        cost: 50,
        profit: 50,
        margin: 50,
        transactions: 1,
      },
      thisMonth: {
        monthStart: "2026-09-01",
        revenue: 1000,
        cost: 600,
        profit: 400,
        margin: 40,
        transactions: 10,
      },
      topItemsThisMonth: [{ name: "Item A", revenue: 500, profit: 200, qty: 5 }],
      openPurchaseOrders: 2,
    };

    const sales = buildToolSystemPrompt("sales_query", {
      summary,
      matchedItems: [
        {
          id: 1,
          name: "Item A",
          code: "A",
          totalQty: 10,
          sellingPrice: 20,
          avgCost: 12,
          totalValue: 120,
          pricingStatus: "PROFITABLE",
        },
      ],
      salesHistory: [
        {
          date: "2026-09-15",
          voucherNumber: "V1",
          qty: 1,
          sellingPrice: 20,
          costPrice: 12,
          profit: 8,
        },
      ],
    } as never);
    expect(sales).toContain("MATCHED ITEM");
    expect(sales).toContain("Recent sales history");

    const business = buildToolSystemPrompt("business_summary", {
      summary,
      lowStock: [
        {
          id: 1,
          name: "Low",
          code: "L",
          qty: 1,
          reorderLevel: 5,
          status: "LOW",
        },
      ],
      pricingHealth: [
        {
          id: 1,
          name: "Loss",
          code: "LOSS",
          sellingPrice: 5,
          avgCost: 7,
          priceGap: -2,
          status: "LOSING",
        },
      ],
    } as never);
    expect(business).toContain("Low stock alerts");
    expect(business).toContain("selling below cost");
  });
});
