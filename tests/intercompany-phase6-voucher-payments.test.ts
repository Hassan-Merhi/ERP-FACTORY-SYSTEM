import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canAccessPairedCash,
  type PaymentMemberRole,
} from "../server/services/intercompany/pairedPaymentAuthorization";
import {
  canOpenIntercompanyVoucherTransfer,
  intercompanyVoucherDetailPath,
} from "../client/src/pages/vouchers/intercompanyTransferPolicy";
import { INTERCOMPANY_VOUCHER_EN } from "../client/src/i18n/intercompanyVoucherTranslations";
import { MoneyDecimal } from "../server/lib/money";
import {
  paymentBaseAmount,
  exactManualAllocation,
  oldestAvailableCredits,
} from "../server/services/intercompany/paymentMoney";

const pair = { sourceCompanyId: 10, destinationCompanyId: 20 };
const memberships: PaymentMemberRole[] = [
  { companyId: 10, role: "Owner" },
  { companyId: 20, role: "Admin" },
];
const actor = (initiatingCompanyId = 10, actorRole = "Owner") => ({
  initiatingCompanyId,
  actorUserId: "owner-test",
  actorRole,
});

describe("Phase 6 — normal Vouchers intercompany payment isolation", () => {
  it("allows paired cash only with verified finance roles in both Properties and ERP", () => {
    expect(canAccessPairedCash(pair, actor(), memberships)).toBe(true);
    expect(canAccessPairedCash(pair, actor(20, "Admin"), memberships)).toBe(true);
    expect(
      canAccessPairedCash(pair, actor(10, "Developer"), [
        { companyId: 10, role: "Developer" },
        { companyId: 20, role: "Developer" },
      ])
    ).toBe(true);
  });

  it("refuses one-sided finance access and cross-pair bank posting", () => {
    expect(canAccessPairedCash(pair, actor(), memberships.slice(0, 1))).toBe(false);
    expect(canAccessPairedCash(pair, actor(), memberships.slice(1))).toBe(false);
    expect(canAccessPairedCash(pair, actor(30), memberships)).toBe(false);
    expect(canAccessPairedCash(pair, actor(10, "Admin"), memberships)).toBe(false);
    expect(canAccessPairedCash(pair, actor(10, "View Only"), memberships)).toBe(false);
    expect(canAccessPairedCash(pair, actor(20, "Worker"), memberships)).toBe(false);
    expect(
      canAccessPairedCash(pair, actor(20, "Admin"), [
        { companyId: 10, role: "Admin" },
        { companyId: 20, role: "Admin" },
      ])
    ).toBe(false);
    expect(
      canAccessPairedCash(pair, actor(20, "Admin"), [
        { companyId: 10, role: "Owner" },
        { companyId: 20, role: "View Only" },
      ])
    ).toBe(false);
  });

  it("exposes the transfer only to finance-capable Properties/ERP users, never POS or read-only", () => {
    expect(canOpenIntercompanyVoucherTransfer({ companyType: "properties", role: "Owner" }, false, false)).toBe(true);
    expect(canOpenIntercompanyVoucherTransfer({ companyType: "properties", role: "Developer" }, false, false)).toBe(
      true
    );
    expect(canOpenIntercompanyVoucherTransfer({ companyType: "properties", role: "Admin" }, false, false)).toBe(false);
    expect(canOpenIntercompanyVoucherTransfer({ companyType: "erp", role: "Admin" }, false, false)).toBe(true);
    expect(canOpenIntercompanyVoucherTransfer({ companyType: "erp", role: "Owner" }, false, false)).toBe(true);
    expect(canOpenIntercompanyVoucherTransfer({ companyType: "erp", role: "View Only" }, false, false)).toBe(false);
    expect(canOpenIntercompanyVoucherTransfer({ companyType: "erp", role: "Owner" }, true, false)).toBe(false);
    expect(canOpenIntercompanyVoucherTransfer({ companyType: "erp", role: "Owner" }, false, true)).toBe(false);
    for (const companyType of ["factory", "factory_v2", "retail", "supplier_partner"]) {
      expect(canOpenIntercompanyVoucherTransfer({ companyType, role: "Owner" }, false, false)).toBe(false);
    }
  });

  it("links only to the actual signed-in company's own posted voucher", () => {
    expect(intercompanyVoucherDetailPath("properties", 10, 20, 10, 51, 62)).toBe("/properties/voucher-detail/51");
    expect(intercompanyVoucherDetailPath("erp", 10, 20, 20, 51, 62)).toBe("/voucher-detail/62");
    expect(intercompanyVoucherDetailPath("erp", 10, 20, 10, 51, 62)).toBeNull();
    expect(intercompanyVoucherDetailPath("properties", 10, 20, 20, 51, 62)).toBeNull();
    expect(intercompanyVoucherDetailPath("erp", 10, 20, 20, 51, 0)).toBeNull();
  });

  it("does not turn ordinary supplier payments or receipt drafts into a paired posting", () => {
    const vouchers = readFileSync("client/src/pages/Vouchers.tsx", "utf8");
    const payments = readFileSync("client/src/pages/intercompany/IntercompanyPayments.tsx", "utf8");
    expect(vouchers).toContain('activeTab === "payment"');
    expect(vouchers).toContain("PaymentVoucherTab");
    expect(vouchers).toContain('activeTab === "intercompany"');
    expect(vouchers).toContain("<IntercompanyVoucherTransfer embedded />");
    expect(vouchers).toContain('activeTab !== "payment" && activeTab !== "receipt"');
    expect(vouchers).not.toContain('apiRequest("POST", "/api/intercompany-container-trading/payments/confirm"');
    expect(payments).toContain('BASE + "/confirm"');
    expect(payments).toContain("sourceReceiptAccount: parseCash(sourceCash)");
    expect(payments).toContain("destinationPaymentAccount: parseCash(destinationCash)");
    expect(payments).toContain("confirmedSourceReceipt: sourceConfirmed");
    expect(payments).toContain("confirmedDestinationPayment: destConfirmed");
  });

  it("reuses one paired payment posting service with transaction, FX, credits and reversal guards", () => {
    const service = readFileSync("server/services/intercompany/paymentSync.ts", "utf8");
    const routes = readFileSync("server/routes/import/intercompany-phase4.ts", "utf8");
    const sql = readFileSync("migrations/20261105_004_intercompany_phase4_payments.sql", "utf8");
    expect(service).toContain("await requirePairedCashAuthorization(pair, actor)");
    expect(service).toContain("db.transaction(async (tx)");
    expect(service).toContain("postErpVoucherTx(tx,");
    expect(service).toContain("paymentAvailableTx(tx");
    expect(service).toContain("confirmMirroredPayment(");
    expect(service).toContain("reverseMirroredPayment(");
    expect(routes).toContain('"/api/intercompany-container-trading/payments/confirm"');
    expect(routes).toContain('"/api/intercompany-container-trading/payments/:paymentId/reverse"');
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS ic_payments_pair_transfer_ref");
    expect(sql).toContain("upper(btrim(transfer_reference))");
  });

  it("preserves historical rates, partial PO allocations and unapplied credits", () => {
    expect(paymentBaseAmount("USD", "100.00", "1").toFixed(2)).toBe("100.00");
    expect(paymentBaseAmount("CFA", "60500.00", "605").toFixed(2)).toBe("100.00");
    exactManualAllocation(
      new MoneyDecimal("100"),
      [new MoneyDecimal("35.00"), new MoneyDecimal("20.00")],
      [new MoneyDecimal("40"), new MoneyDecimal("80")]
    );
    expect(() =>
      exactManualAllocation(new MoneyDecimal("50"), [new MoneyDecimal("41.00")], [new MoneyDecimal("40")])
    ).toThrow();
    expect(
      oldestAvailableCredits(
        [
          { id: 4, available: new MoneyDecimal("10") },
          { id: 9, available: new MoneyDecimal("20") },
        ],
        new MoneyDecimal("15")
      ).map((x) => x.amount.toFixed(2))
    ).toEqual(["10.00", "5.00"]);
  });

  it("keeps paired voucher history and the supplier payment distinction visible", () => {
    const page = readFileSync("client/src/pages/intercompany/IntercompanyPayments.tsx", "utf8");
    expect(page).toContain("intercompanyVoucherDetailPath(");
    expect(page).toContain("row.sourceVoucherId");
    expect(page).toContain("row.destinationVoucherId");
    expect(page).toContain("setRequestKey(newKey())");
    expect(page).toContain('setTransferReference("")');
    expect(INTERCOMPANY_VOUCHER_EN.supplierExplanation).toContain("Normal supplier payments");
    expect(INTERCOMPANY_VOUCHER_EN.transferSafety).toContain("cannot be posted twice");
  });
});
