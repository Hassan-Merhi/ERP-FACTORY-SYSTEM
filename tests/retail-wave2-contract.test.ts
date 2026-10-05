/**
 * Retail Wave 2 contract tests.
 *
 * These lock the seams other teams rely on: the schema columns the money model needs, the
 * startup guard that production actually runs, route registration, the approval-token wiring,
 * the client UI entry points, and the EN/AR/FR translations for the new screens.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensureRetailSellingSchema, ensureRetailStockCountSchema } from "../server/startup/ensureRuntimeSchema";

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Retail Wave 2 — schema", () => {
  it("keeps the sale money ladder and never destroys the original price", () => {
    const schema = read("shared/schema/retailPos.ts");
    for (const column of [
      "listSubtotal",
      "discountTotal",
      "subtotal",
      "taxAmount",
      "taxEnabled",
      "taxInclusive",
      "orderDiscountType",
      "orderDiscountAmount",
      "originalUnitPrice",
      "grossUnitPrice",
      "lineDiscountAmount",
      "lineDiscountType",
      "priceOverride",
      "promotionId",
      "customerId",
      "customerName",
      "approvedByUserId",
    ]) {
      expect(schema, `${column} must stay on the retail sale schema`).toContain(column);
    }
    // The list price snapshot is written once and never updated by a discount flow.
    expect(schema).toContain("original_unit_price");
  });

  it("defines settings, promotions, approvals and the stock-count tables", () => {
    const selling = read("shared/schema/retailSelling.ts");
    expect(selling).toContain("retail_pos_settings");
    expect(selling).toContain("retail_promotions");
    expect(selling).toContain("retail_discount_approvals");
    expect(selling).toContain("consumedSaleId");

    const stockCount = read("shared/schema/retailStockCount.ts");
    expect(stockCount).toContain("retail_stock_count_sessions");
    expect(stockCount).toContain("retail_stock_count_lines");
    expect(stockCount).toContain("retail_stock_count_events");
    expect(stockCount).toContain("finalized_result");
    expect(stockCount).toContain("RETAIL_STOCK_COUNT_STATUSES");
    expect(stockCount).toContain("recountRequired");

    const index = read("shared/schema/index.ts");
    for (const module of ["retailSelling", "retailStockCount"]) {
      expect(index).toContain(module);
    }
  });

  it("mirrors every Wave 2 table in the always-on startup guard", () => {
    const guard = read("server/startup/ensureRuntimeSchema.ts");
    expect(guard).toContain("ensureRetailSellingSchema");
    expect(guard).toContain("ensureRetailStockCountSchema");
    for (const table of [
      "retail_pos_settings",
      "retail_promotions",
      "retail_discount_approvals",
      "retail_stock_count_sessions",
      "retail_stock_count_lines",
      "retail_stock_count_events",
    ]) {
      expect(guard, `${table} must be created by the startup guard`).toContain(table);
    }
    // The guard is what production runs, so the Wave 2 sale columns must be added there too.
    for (const column of ["customer_id", "tax_amount", "line_discount_amount", "promotion_id", "gross_unit_price"]) {
      expect(guard, `${column} must be ensured at startup`).toContain(column);
    }
  });
});

describe("Retail Wave 2 — service wiring", () => {
  it("prices carts in the sale service and consumes approvals inside the sale transaction", () => {
    const service = read("server/services/retail/retailSaleService.ts");
    expect(service).toContain("prepareRetailSalePricing");
    expect(service).toContain("RetailApprovalReuseError");
    expect(service).toContain("consumedSaleId");
    expect(service).toContain("grossUnitPrice");
  });

  it("signs approval tokens only with a cart fingerprint and covers the request at checkout", () => {
    const approval = read("server/services/retail/retailDiscountApproval.ts");
    expect(approval).toContain("retailApprovalFingerprint");
    expect(approval).toContain("signRetailApprovalToken");

    const sellers = read("server/routes/pos/retailSellingRoutes.ts");
    expect(sellers).toContain("signRetailApprovalToken");
    expect(sellers).toContain("fingerprint");
    // Approvals verify with bcrypt only: a legacy SHA-256 hash is refused instead of
    // being compared with a weak digest, so the new credential flow never reaches it.
    expect(sellers).toContain("verifyPasswordBcryptOnly");
    expect(sellers).toContain("MANAGER_PASSWORD_RESET_REQUIRED");
    expect(sellers).not.toContain("verifyPassword(");

    const checkout = read("server/routes/pos/retailPosRoutes.ts");
    expect(checkout).toContain("approvalCoversRequest");
    expect(checkout).toContain("payload.fingerprint === fingerprint");
    for (const code of [
      "DISCOUNT_REASON_REQUIRED",
      "DISCOUNT_APPROVAL_REQUIRED",
      "DISCOUNT_APPROVAL_INVALID",
      "DISCOUNT_APPROVAL_EXPIRED",
    ]) {
      expect(checkout, `${code} must be returned by checkout`).toContain(code);
    }
    expect(checkout).toContain("RetailApprovalReuseError");
  });

  it("finalizes stock counts through the movement ledger, never by writing inventory directly", () => {
    const stockCount = read("server/services/retail/retailStockCount.ts");
    // Inventory is only ever touched through the shared movement ledger.
    expect(stockCount).toContain('from "./retailStockLedger"');
    expect(stockCount).toContain("addMovement");
    expect(stockCount).toContain("lockInventoryRow");
    expect(stockCount).toContain("setInventoryQuantity");
    expect(stockCount).toContain("stock_count");
    expect(stockCount).toContain("retail_stock_count");
    expect(stockCount).toContain("STOCK_COUNT_UNCOUNTED_LINES");
    expect(stockCount).toContain("STOCK_COUNT_VARIANCE_UNCONFIRMED");
    expect(stockCount).toContain("finalizedResult");
  });

  it("reports tax collected, discounts given and customer counts", () => {
    const reporting = read("server/services/retail/retailReporting.ts");
    expect(reporting).toContain("tax_collected");
    expect(reporting).toContain("discount_given");
    expect(reporting).toContain("customer_count");
  });
});

describe("Retail Wave 2 — routes", () => {
  it("registers every Wave 2 endpoint", () => {
    const posIndex = read("server/routes/pos/index.ts");
    for (const registrar of [
      "registerRetailCustomerRoutes",
      "registerRetailSellingRoutes",
      "registerRetailStockCountRoutes",
    ]) {
      expect(posIndex).toContain(registrar);
    }
    expect(read("server/routes/stockRoutes.ts")).toContain("registerRetailSettingsRoutes");

    const checkout = read("server/routes/pos/retailPosRoutes.ts");
    expect(checkout).toContain('"/api/pos/retail/cart-preview"');

    const customers = read("server/routes/pos/retailCustomerRoutes.ts");
    expect(customers).toContain('"/api/pos/retail/customers"');
    expect(customers).toContain('"/api/pos/retail/customers/:id/history"');
    expect(customers).toContain('"/api/pos/retail/sales/search"');
    expect(customers).toContain("normalizeRetailReceiptNumber");

    const settings = read("server/routes/retailSettingsRoutes.ts");
    for (const routePath of [
      '"/api/pos/retail/settings"',
      '"/api/pos/retail/promotions/active"',
      '"/api/retail/promotions"',
    ]) {
      expect(settings).toContain(routePath);
    }

    const stockCount = read("server/routes/pos/retailStockCountRoutes.ts");
    for (const suffix of ["/start", "/scan", "/review", "/recount", "/finalize", "/cancel"]) {
      expect(stockCount).toContain(suffix);
    }
    expect(stockCount).toContain("/variance");
    expect(stockCount).toContain("requireNonPOS");
  });

  it("routes are reachable through the application registry", () => {
    const application = read("server/routes/applicationRoutes.ts");
    expect(application).toContain("registerPosRoutes");
    expect(application).toContain("registerStockRoutes");
  });
});

describe("Retail Wave 2 — client UI", () => {
  it("exposes the POS customer picker, line adjustments, approval dialog and totals ladder", () => {
    const pos = read("client/src/pages/pos/RetailPOS.tsx");
    for (const marker of [
      "RetailCustomerPicker",
      "RetailLineAdjustDialog",
      "RetailApprovalDialog",
      "cart-preview",
      "cart-list-subtotal",
      "cart-discount-total",
      "cart-tax",
      "retail-approval-hint",
      "approvalToken",
    ]) {
      expect(pos, `${marker} must be wired into the POS`).toContain(marker);
    }

    const receipt = read("client/src/pages/pos/retailReceipt.tsx");
    for (const marker of ["customerName", "listSubtotal", "discountTotal", "taxAmount", "grossUnitPrice"]) {
      expect(receipt, `the receipt must print ${marker}`).toContain(marker);
    }
  });

  it("keeps manager credentials out of the offline queue", () => {
    const api = read("client/src/pages/pos/retailWave2Api.ts");
    expect(api).toContain("apiRequestPrivileged");
    expect(api).not.toContain('apiRequest("POST", "/api/pos/retail/discount-approvals"');

    const queryClient = read("client/src/lib/queryClient.ts");
    expect(queryClient).toContain("export async function apiRequestPrivileged");
    // The queueable path refuses credential payloads as defence in depth.
    expect(queryClient).toContain("!containsSensitiveCredentials(data)");

    const queue = read("client/src/lib/offlineQueue.ts");
    expect(queue).toContain("export function containsSensitiveCredentials");
    expect(queue).toContain("managerPassword");
    expect(queue).toContain("/^\\/api\\/pos\\/retail\\/discount-approvals$/");
    expect(queue).toContain("/^\\/api\\/user\\/change-password$/");
  });

  it("registers the stock count, selling settings and sales history workspaces", () => {
    const routes = read("client/src/routes/AppRoutes.tsx");
    for (const page of ["RetailStockCount", "RetailSellingSettings", "RetailSalesHistory"]) {
      expect(routes).toContain(page);
    }
    const nav = read("client/src/pages/retail/RetailNav.tsx");
    for (const href of ["/retail/stock-count", "/retail/selling", "/retail/history"]) {
      expect(nav).toContain(href);
    }
    const stockCount = read("client/src/pages/retail/RetailStockCount.tsx");
    for (const marker of [
      "stock-count-scan",
      "stock-count-finalize",
      "stock-count-line-quantity",
      "stock-count-recount",
    ]) {
      expect(stockCount).toContain(marker);
    }
    expect(read("client/src/pages/retail/RetailSellingSettings.tsx")).toContain("retail-settings-tax-enabled");
    expect(read("client/src/pages/retail/RetailSalesHistory.tsx")).toContain("retail-history-receipt");
  });

  it("translates the new screens into EN/AR/FR", () => {
    const translations = read("client/src/i18n/retailWave2Translations.ts");
    for (const phrase of [
      "Physical stock count",
      "Selling settings",
      "Whole-sale discount",
      "Manager approval required",
      "Sales & customer history",
      "Net variance (units)",
    ]) {
      expect(translations, `${phrase} needs a translation entry`).toContain(`en: ${JSON.stringify(phrase)}`);
    }
    expect(translations).toContain("createPhase3TemplateTranslator");
    expect(read("client/src/components/ApplicationInterfaceTranslator.tsx")).toContain("translateRetailWave2Text");
  });
});

describeWithDatabase("Retail Wave 2 — runtime schema guard", () => {
  it("creates and keeps the Wave 2 tables without touching existing data", async () => {
    await ensureRetailSellingSchema(pool);
    await ensureRetailSellingSchema(pool);
    await ensureRetailStockCountSchema(pool);
    await ensureRetailStockCountSchema(pool);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [
        [
          "retail_pos_settings",
          "retail_promotions",
          "retail_discount_approvals",
          "retail_stock_count_sessions",
          "retail_stock_count_lines",
          "retail_stock_count_events",
        ],
      ]
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "retail_discount_approvals",
      "retail_pos_settings",
      "retail_promotions",
      "retail_stock_count_events",
      "retail_stock_count_lines",
      "retail_stock_count_sessions",
    ]);

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name = 'retail_pos_sales' OR table_name = 'retail_stock_count_lines')
         AND column_name IN ('customer_id', 'tax_amount', 'discount_total', 'movement_delta', 'expected_live_quantity')
       ORDER BY table_name, column_name`
    );
    expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      "retail_pos_sales.customer_id",
      "retail_pos_sales.discount_total",
      "retail_pos_sales.tax_amount",
      "retail_stock_count_lines.expected_live_quantity",
      "retail_stock_count_lines.movement_delta",
    ]);
  });
});
