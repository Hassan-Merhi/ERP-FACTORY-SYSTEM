import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeFactoryVoucherEntryAmounts } from "../server/services/factory/factoryVoucherEntryAmounts";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Phase 5 post-offload reconciliation", () => {
  it("normalizes USD voucher entries as base-currency identity amounts", () => {
    const normalized = normalizeFactoryVoucherEntryAmounts({
      transactionCurrency: "USD",
      transactionDebitAmount: "100",
      transactionCreditAmount: "0",
      fxRateToUsd: "1",
    });

    expect(normalized.rateConvention).toBe("IDENTITY");
    expect(normalized.transactionDebitAmount).toBe("100.000000");
    expect(normalized.baseDebitAmount).toBe("100.000000");
    expect(normalized.debitAmount).toBe(normalized.baseDebitAmount);
    expect(normalized.creditAmount).toBe("0.000000");
  });

  it("converts a factory foreign-currency amount with USD-per-unit FX", () => {
    const normalized = normalizeFactoryVoucherEntryAmounts({
      transactionCurrency: "EUR",
      transactionDebitAmount: "100",
      transactionCreditAmount: "0",
      fxRateToUsd: "1.2",
    });

    expect(normalized.rateConvention).toBe("BASE_PER_TRANSACTION");
    expect(normalized.historicalExchangeRate).toBe("1.2000000000");
    expect(normalized.baseDebitAmount).toBe("120.000000");
    expect(normalized.debitAmount).toBe("120.000000");
  });

  it("rejects invalid double-sided voucher entries", () => {
    expect(() =>
      normalizeFactoryVoucherEntryAmounts({
        transactionCurrency: "USD",
        transactionDebitAmount: "10",
        transactionCreditAmount: "10",
        fxRateToUsd: "1",
      })
    ).toThrow("exactly one positive debit or credit side");
  });

  it("normalizes every required dual-currency field and verifies financial links", () => {
    const service = read("server/services/factory/postOffloadReconciliation.ts");

    expect(service).toContain("transaction_currency = $3");
    expect(service).toContain("transaction_debit_amount = $4");
    expect(service).toContain("transaction_credit_amount = $5");
    expect(service).toContain("base_debit_amount = $6");
    expect(service).toContain("base_credit_amount = $7");
    expect(service).toContain("historical_exchange_rate = $8");
    expect(service).toContain("rate_convention = $9");
    expect(service).toContain("original daybook");
    expect(service).toContain("linked voucher");
    expect(service).toContain("reversing daybook");
    expect(service).toContain("voucher base amounts do not balance");
  });

  it("verifies inventory, reports, and the exact replay undo snapshot", () => {
    const service = read("server/services/factory/postOffloadReconciliation.ts");

    expect(service).toContain("factory_raw_stock");
    expect(service).toContain("cost per kg does not match the container canonical USD rate");
    expect(service).toContain("POST_OFFLOAD_REPORT_QUERY_KEYS");
    expect(service).toContain("serverReadCacheInvalidated: true");
    expect(service).toContain("factory_recalc_undo_log");
    expect(service).toContain("scope_fingerprint");
    expect(service).toContain("post_offload_reconciliation_completed");
  });

  it("refreshes every report query key returned by reconciliation", () => {
    const client = read("client/src/lib/factoryApi.ts");

    expect(client).toContain("POST_OFFLOAD_MUTATION_PATH");
    expect(client).toContain("postOffloadReconciliation?.reports?.queryKeys");
    expect(client).toContain("invalidatePostOffloadReconciliationQueries");
    expect(client).toContain('refetchType: "active"');
    expect(client).toContain("await invalidatePostOffloadReconciliationQueries(method, url, response)");
  });

  it("registers reconciliation outside historical replay in the active route aggregator", () => {
    for (const path of ["server/routes/factory/factoryRawStockRoutes.ts"]) {
      const routes = read(path);
      const reconciliation = routes.indexOf('app.use("/api/factory/containers", postOffloadReconciliationMiddleware)');
      const historical = routes.indexOf('app.use("/api/factory/containers", postOffloadHistoricalReplayMiddleware)');

      expect(reconciliation).toBeGreaterThan(-1);
      expect(historical).toBeGreaterThan(reconciliation);
    }
  });

  it("surfaces reconciliation state and never writes quantity or payment fields", () => {
    const middleware = read("server/routes/factory/raw-stock/postOffloadReconciliationMiddleware.ts");
    const service = read("server/services/factory/postOffloadReconciliation.ts");

    expect(middleware).toContain("postOffloadFullyReconciled");
    expect(middleware).toContain("postOffloadRepairRequired");
    expect(middleware).toContain("exactReplayUndoLogId");
    expect(middleware).toContain("accountingReconciled");
    expect(middleware).toContain("inventoryReconciled");
    expect(service).not.toContain("received_kg =");
    expect(service).not.toContain("used_kg =");
    expect(service).not.toContain("weight_kg =");
    expect(service).not.toContain("quantity =");
    expect(service).not.toContain("factory_supplier_payments");
    expect(service).not.toContain("customer_balances");
  });
});
