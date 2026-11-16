import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  mayOfferRentalPaymentDelete,
  rentalPaymentDateLabel,
  rentalPaymentDeletionImpact,
} from "../client/src/properties/config/rentalPaymentPresentation";
import { receiptTotals, cashCents, nonCashCents } from "../client/src/pages/properties/property-rental/paymentsReceiptMath";
import { getRentalModulePolicy } from "../client/src/properties/config/rentalModulePolicy";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("Phase 9 rental payment UI parity", () => {
  it("shows accurate deletion impact by rental module without implying a Properties auto-transfer", () => {
    const properties = rentalPaymentDeletionImpact("PROPERTIES");
    expect(properties).toContain("do not automatically transfer");
    expect(properties).toContain("any previously linked transfer");
    for (const module of ["FACTORY", "ERP"] as const) {
      const text = rentalPaymentDeletionImpact(module);
      expect(text).toContain("Any linked inter-company transfer");
      expect(text).not.toContain("do not automatically transfer");
    }
  });

  it("keeps Properties sourced payments editable only if they are not read-only", () => {
    expect(mayOfferRentalPaymentDelete("PROPERTIES", false, "PROPERTIES")).toBe(true);
    expect(mayOfferRentalPaymentDelete("ERP", false, "PROPERTIES")).toBe(false);
    expect(mayOfferRentalPaymentDelete(undefined, false, "PROPERTIES")).toBe(false);
    expect(mayOfferRentalPaymentDelete("PROPERTIES", true, "PROPERTIES")).toBe(false);
    expect(mayOfferRentalPaymentDelete("ERP", false, "ERP")).toBe(true);
    expect(mayOfferRentalPaymentDelete("FACTORY", true, "FACTORY")).toBe(false);
  });

  it("renders recorded payment dates without browser-local timezone shifts", () => {
    expect(rentalPaymentDateLabel("2026-11-01")).toBe("01 Nov 2026");
    expect(rentalPaymentDateLabel("2026-11-01T00:00:00.000Z")).toBe("01 Nov 2026");
    expect(rentalPaymentDateLabel("invalid")).toBe("invalid");
  });

  it("keeps module API paths unchanged", () => {
    expect(getRentalModulePolicy("PROPERTIES").apiBase).toBe("/api/properties/rental");
    expect(getRentalModulePolicy("FACTORY").apiBase).toBe("/api/factory/rental");
    expect(getRentalModulePolicy("ERP").apiBase).toBe("/api/erp/rental");
  });

  it("preserves classification and cents from posted cash, billed and scheduled rows", () => {
    const cash = { id: 1, paymentDate: "2026-11-01", amount: "25.50", voucherId: 10, cashAccountId: 20, postingStatus: "POSTED" };
    const billing = { id: 2, paymentDate: "2026-11-01", amount: "10.00", voucherId: null, cashAccountId: null, postingStatus: "POSTED" };
    const scheduled = { id: 3, paymentDate: "2026-12-01", amount: "20.00", voucherId: null, cashAccountId: null, postingStatus: "SCHEDULED" };
    expect(cashCents(cash)).toBe(2550);
    expect(nonCashCents(billing)).toBe(1000);
    expect(receiptTotals([cash, billing, scheduled])).toEqual({
      cash: 2550, nonCash: 1000, scheduled: 2000, recorded: 5550,
    });
  });

  it("reuses one deletion dialog and does not retain unreachable reconciliation tabs", () => {
    const page = read("../client/src/pages/properties/RentalPaymentsLog.tsx");
    const hook = read("../client/src/properties/hooks/useRentalPaymentsFilters.ts");
    expect(page).toContain("<RentalPaymentDeleteDialog");
    expect(page).not.toContain("<ConfirmDialog");
    expect(page).not.toContain("RECONCILIATION_VIEWS");
    expect(hook).not.toContain("effectiveView");
    expect(hook).not.toContain("setReconciliationView");
  });

  it("does not label ordinary Properties payment copies as full account reconciliations", () => {
    const page = read("../client/src/pages/properties/RentalPaymentsLog.tsx");
    expect(page).toContain("const isFullHistory = isHassanProperties && noFilters");
    expect(page).toContain("const copyIsFull = isFullHistory;");
    expect(page).toContain("fullHistory={copyIsFull}");
    expect(page).toContain('onCopy={() => {');
    expect(page).toContain('void (isFullHistory ? copyFullHistory() : copyHistory());');
  });

  it("preserves the premium Properties table and existing readonly record protection", () => {
    const premium = read("../client/src/pages/properties/property-rental/components/PropertiesPaymentsPremium.tsx");
    expect(premium).toContain("properties-payments-premium");
    expect(premium).toContain("mayOfferRentalPaymentDelete");
    expect(premium).toContain("disabled={readOnly}");
  });
});
