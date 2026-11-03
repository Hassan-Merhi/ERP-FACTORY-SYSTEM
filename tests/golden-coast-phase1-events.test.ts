/**
 * Golden Coast Phase 1 event adapter: the preview for every event type, the
 * ledger and cash role each account must play, input validation, business
 * errors surfaced as input errors, and which events cannot be posted alone.
 * Uses the real Phase 1 voucher builders.
 */
import { describe, expect, it } from "vitest";
import {
  buildGoldenCoastPhase1PostingRequest,
  buildGoldenCoastPhase1Preview,
  getGoldenCoastPhase1CashRoleRequirements,
  getGoldenCoastPhase1LedgerRoleRequirements,
  GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES,
  GoldenCoastPhase1InputError,
} from "../server/services/accounting/goldenCoastPhase1Posting";

const ledger = (id: number) => ({ kind: "ledger" as const, id });
const bank = (id: number) => ({ kind: "bank" as const, id, name: " Main bank " });

const events = {
  contribution: {
    type: "partner_cash_contribution",
    amountUsd: 1000,
    cashAccount: bank(9),
    partnerCapitalAccount: ledger(3),
    partnerName: "Fresh Start",
  },
  inTransit: {
    type: "inventory_in_transit_contribution",
    goodsCostUsd: "5000",
    stockOtwAccount: ledger(2),
    partnerCapitalAccount: ledger(3),
    partnerName: " Fresh Start ",
    containerReference: " C-1 ",
  },
  reserve: { type: "container_reserve_plan", reserveUsd: 9000, expectedDutyUsd: 3000, expectedTransportUsd: 2000 },
  funding: {
    type: "funding_allocation_plan",
    fundingBalanceUsd: 100000,
    inventoryInTransitUsd: 60000,
    containerReserveUsd: 9000,
  },
  costPayment: {
    type: "container_cost_payment",
    amountUsd: "1200",
    stockOtwAccount: ledger(2),
    paymentAccount: bank(9),
    chargeLabel: "Duty",
    containerReference: "",
  },
  offload: {
    type: "container_offload",
    totalLandedCostUsd: "6200",
    inventoryAccount: ledger(4),
    stockOtwAccount: ledger(2),
    locationId: "5",
  },
  savings: { type: "savings_transfer", amountUsd: 500, operatingCashAccount: ledger(101), savingsAccount: bank(2) },
  withdrawal: {
    type: "owner_withdrawal",
    amountUsd: 300,
    ownerDrawingsAccount: ledger(6),
    paymentAccount: bank(9),
    ownerName: "Hassan",
  },
  economics: { type: "sale_economics", quantity: 10, salePricePerUnitUsd: "25", inventoryCostPerUnitUsd: "18" },
  sale: {
    type: "location_sale",
    quantity: 10,
    salePricePerUnitUsd: "25",
    inventoryCostPerUnitUsd: "18",
    locationId: 5,
    cashOrReceivableAccount: bank(9),
    salesRevenueAccount: ledger(7),
    cogsAccount: ledger(8),
    inventoryAccount: ledger(4),
    description: "  Shop sale ",
  },
};

function inputError(work: () => unknown) {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(GoldenCoastPhase1InputError);
    return (error as Error).message;
  }
  throw new Error("expected an input error");
}

describe("buildGoldenCoastPhase1Preview", () => {
  it("builds the voucher for each posting event", () => {
    expect(buildGoldenCoastPhase1Preview(events.inTransit)).toEqual({
      kind: "voucher",
      eventType: "inventory_in_transit_contribution",
      voucher: {
        voucherType: "Journal",
        totalAmount: "5000.00",
        description: "Fresh Start inventory contribution - Stock OTW (C-1)",
        entries: [
          {
            ledgerAccountId: 2,
            debitAmount: "5000.00",
            creditAmount: "0.00",
            narration: "Fresh Start inventory contribution - Stock OTW (C-1)",
          },
          {
            ledgerAccountId: 3,
            debitAmount: "0.00",
            creditAmount: "5000.00",
            narration: "Fresh Start inventory contribution - Stock OTW (C-1)",
          },
        ],
      },
    });
    expect(buildGoldenCoastPhase1Preview(events.costPayment)).toMatchObject({
      kind: "voucher",
      voucher: {
        voucherType: "Payment",
        totalAmount: "1200.00",
        description: "Duty capitalized to Stock OTW",
        entries: [
          { ledgerAccountId: 2, debitAmount: "1200.00" },
          { bankAccountId: 9, creditAmount: "1200.00" },
        ],
      },
    });
    expect(buildGoldenCoastPhase1Preview(events.offload)).toMatchObject({
      voucher: {
        voucherType: "Journal",
        locationId: 5,
        entries: [
          { ledgerAccountId: 4, debitAmount: "6200.00" },
          { ledgerAccountId: 2, creditAmount: "6200.00" },
        ],
      },
    });
    expect(buildGoldenCoastPhase1Preview(events.withdrawal)).toMatchObject({
      voucher: {
        voucherType: "Payment",
        description: "Hassan owner withdrawal",
        entries: [
          { ledgerAccountId: 6, debitAmount: "300.00" },
          { bankAccountId: 9, creditAmount: "300.00" },
        ],
      },
    });
    expect(buildGoldenCoastPhase1Preview(events.savings)).toMatchObject({
      kind: "voucher",
      eventType: "savings_transfer",
    });
    expect(buildGoldenCoastPhase1Preview(events.contribution)).toMatchObject({
      kind: "voucher",
      eventType: "partner_cash_contribution",
    });
    expect(buildGoldenCoastPhase1Preview(events.sale)).toMatchObject({
      voucher: {
        voucherType: "Sales",
        totalAmount: "250.00",
        locationId: 5,
        description: "Shop sale",
        entries: [
          { bankAccountId: 9, debitAmount: "250.00", narration: "Shop sale - proceeds" },
          { ledgerAccountId: 7, creditAmount: "250.00" },
          { ledgerAccountId: 8, debitAmount: "180.00" },
          { ledgerAccountId: 4, creditAmount: "180.00" },
        ],
      },
    });
  });

  it("returns plans for the planning events", () => {
    expect(buildGoldenCoastPhase1Preview(events.reserve)).toEqual({
      kind: "plan",
      eventType: "container_reserve_plan",
      result: {
        reserveUsd: "9000.00",
        expectedDutyUsd: "3000.00",
        expectedTransportUsd: "2000.00",
        expectedTotalUsd: "5000.00",
        reserveHeadroomUsd: "4000.00",
      },
    });
    expect(buildGoldenCoastPhase1Preview(events.funding)).toMatchObject({
      kind: "plan",
      result: { savingsAvailableUsd: "31000.00" },
    });
    expect(buildGoldenCoastPhase1Preview(events.economics)).toEqual({
      kind: "plan",
      eventType: "sale_economics",
      result: { quantity: "10", revenueUsd: "250.00", cogsUsd: "180.00", grossProfitUsd: "70.00" },
    });
  });

  it("validates the event shape and its fields", () => {
    for (const event of [null, "x", [events.contribution]]) {
      expect(inputError(() => buildGoldenCoastPhase1Preview(event))).toBe("event must be an object");
    }
    expect(inputError(() => buildGoldenCoastPhase1Preview({ type: " " }))).toBe("event.type is required");
    expect(inputError(() => buildGoldenCoastPhase1Preview({ type: "refund" }))).toBe(
      "Unsupported Phase 1 event type: refund"
    );
    expect(inputError(() => buildGoldenCoastPhase1Preview({ ...events.contribution, amountUsd: true }))).toBe(
      "event.amountUsd must be a number or numeric string"
    );
    expect(inputError(() => buildGoldenCoastPhase1Preview({ ...events.contribution, partnerName: "" }))).toBe(
      "event.partnerName is required"
    );
    expect(inputError(() => buildGoldenCoastPhase1Preview({ ...events.inTransit, containerReference: 7 }))).toBe(
      "event.containerReference must be a string"
    );
    expect(inputError(() => buildGoldenCoastPhase1Preview({ ...events.contribution, cashAccount: "bank" }))).toBe(
      "event.cashAccount must be an object"
    );
    expect(
      inputError(() => buildGoldenCoastPhase1Preview({ ...events.contribution, cashAccount: { kind: "cash", id: 1 } }))
    ).toBe('event.cashAccount.kind must be "ledger" or "bank"');
    for (const id of [0, -1, 1.5, "x"]) {
      expect(
        inputError(() => buildGoldenCoastPhase1Preview({ ...events.contribution, cashAccount: { kind: "bank", id } }))
      ).toBe("event.cashAccount.id must be a positive integer");
    }
    expect(
      inputError(() => buildGoldenCoastPhase1Preview({ ...events.contribution, partnerCapitalAccount: bank(3) }))
    ).toBe("event.partnerCapitalAccount must reference a ledger account");
    expect(inputError(() => buildGoldenCoastPhase1Preview({ ...events.offload, locationId: 0 }))).toBe(
      "event.locationId must be a positive integer"
    );
  });

  it("reports builder business-rule failures as input errors", () => {
    const message = inputError(() => buildGoldenCoastPhase1Preview({ ...events.withdrawal, amountUsd: "-5" }));
    expect(message).not.toBe("");
    expect(inputError(() => buildGoldenCoastPhase1Preview({ ...events.reserve, reserveUsd: "abc" }))).toBeTruthy();
  });
});

describe("role requirements", () => {
  it("lists the ledger subtype each event's accounts must carry", () => {
    const capital = ["gc_partner_capital", "gc_owner_capital"];
    expect(getGoldenCoastPhase1LedgerRoleRequirements(events.contribution)).toEqual([
      { accountId: 3, label: "event.partnerCapitalAccount", allowedSubTypes: capital },
    ]);
    expect(getGoldenCoastPhase1LedgerRoleRequirements(events.inTransit)).toEqual([
      { accountId: 2, label: "event.stockOtwAccount", allowedSubTypes: ["sp_goods_otw"] },
      { accountId: 3, label: "event.partnerCapitalAccount", allowedSubTypes: capital },
    ]);
    expect(getGoldenCoastPhase1LedgerRoleRequirements(events.costPayment)).toEqual([
      { accountId: 2, label: "event.stockOtwAccount", allowedSubTypes: ["sp_goods_otw"] },
    ]);
    expect(getGoldenCoastPhase1LedgerRoleRequirements(events.offload)).toEqual([
      { accountId: 4, label: "event.inventoryAccount", allowedSubTypes: ["sp_stock"] },
      { accountId: 2, label: "event.stockOtwAccount", allowedSubTypes: ["sp_goods_otw"] },
    ]);
    expect(getGoldenCoastPhase1LedgerRoleRequirements(events.withdrawal)).toEqual([
      { accountId: 6, label: "event.ownerDrawingsAccount", allowedSubTypes: ["gc_owner_drawings"] },
    ]);
    expect(getGoldenCoastPhase1LedgerRoleRequirements(events.sale)).toEqual([
      { accountId: 7, label: "event.salesRevenueAccount", allowedSubTypes: ["sp_sales"] },
      { accountId: 8, label: "event.cogsAccount", allowedSubTypes: ["sp_cogs"] },
      { accountId: 4, label: "event.inventoryAccount", allowedSubTypes: ["sp_stock"] },
    ]);
    for (const event of [events.savings, events.reserve, events.funding, events.economics]) {
      expect(getGoldenCoastPhase1LedgerRoleRequirements(event)).toEqual([]);
    }
    expect(
      inputError(() =>
        getGoldenCoastPhase1LedgerRoleRequirements({ ...events.withdrawal, ownerDrawingsAccount: bank(6) })
      )
    ).toBe("event.ownerDrawingsAccount must reference a ledger account");
    expect(GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES).toEqual([
      "sp_goods_otw",
      "sp_stock",
      "sp_sales",
      "sp_cogs",
      "gc_partner_capital",
      "gc_owner_capital",
      "gc_owner_drawings",
    ]);
  });

  it("lists the cash or bank counterpart of payments and withdrawals", () => {
    const named = { kind: "bank", id: 9, name: "Main bank" };
    expect(getGoldenCoastPhase1CashRoleRequirements(events.costPayment)).toEqual([
      { account: named, label: "event.paymentAccount" },
    ]);
    expect(getGoldenCoastPhase1CashRoleRequirements(events.withdrawal)).toEqual([
      { account: named, label: "event.paymentAccount" },
    ]);
    for (const event of [events.inTransit, events.offload, events.sale, events.reserve]) {
      expect(getGoldenCoastPhase1CashRoleRequirements(event)).toEqual([]);
    }
  });
});

describe("buildGoldenCoastPhase1PostingRequest", () => {
  const request = (event: unknown, over: Record<string, unknown> = {}) =>
    buildGoldenCoastPhase1PostingRequest({
      companyId: 7,
      clientRequestId: "gc-req-0001",
      voucherNumber: "GC-1",
      voucherDate: "2026-11-01",
      event,
      exchangeRate: null,
      ...over,
    });

  it("refuses planning events and a location sale posted on its own", () => {
    for (const event of [events.reserve, events.funding, events.economics]) {
      expect(inputError(() => request(event))).toBe(
        `${(event as { type: string }).type} is a planning event and cannot be posted`
      );
    }
    expect(inputError(() => request(events.sale))).toBe(
      "location_sale must be posted with buildGoldenCoastPhase1PostingBatch so Sales and COGS remain separate vouchers"
    );
  });

  it("posts the voucher with a Golden Coast source and requires its number and date", () => {
    const built = request(events.offload);
    expect(built.eventType).toBe("container_offload");
    expect(built.request.source).toEqual({
      sourceType: "golden-coast-phase1",
      sourceId: `container_offload:${built.clientRequestId}`,
      idempotencyKey: `golden-coast-phase1:${built.clientRequestId}`,
    });
    expect(inputError(() => request(events.offload, { voucherNumber: " " }))).toBe("voucherNumber is required");
    expect(inputError(() => request(events.offload, { voucherDate: undefined }))).toBe("voucherDate is required");
  });
});
