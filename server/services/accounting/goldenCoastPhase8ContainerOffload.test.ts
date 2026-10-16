import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE,
  GoldenCoastPhase8Error,
  buildGoldenCoastPhase8FundingPosting,
  buildGoldenCoastFreshStartExcelFundingPosting,
  buildGoldenCoastPhase8OffloadPosting,
  parseGoldenCoastPhase8ContainerInput,
  parseGoldenCoastPhase8OffloadInput,
  planGoldenCoastPhase8Funding,
  planGoldenCoastPhase8Offload,
  type GoldenCoastPhase8FundedContainerState,
} from "./goldenCoastPhase8ContainerOffload";

const accounts = {
  stockOtwAccountId: 10,
  stockInHandAccountId: 11,
  containerReserveAccountId: 12,
  hassanEquityAccountId: 13,
  hassanSavingsAccountId: 14,
};

function container() {
  return parseGoldenCoastPhase8ContainerInput({
    companyId: 7,
    body: {
      clientRequestId: "phase8-a",
      supplierName: "Fresh Start",
      containerNumber: "CNT-8",
      invoiceNumber: "FS-8",
      invoiceDate: "2026-09-05",
      reserveUsd: "22300",
      fundingAccount: { kind: "ledger", id: 99 },
      lines: [{ stockItemId: 1, articleCode: "BAG", description: "Bag", qty: "2000", unitRateUsd: "22" }],
    },
  });
}

function funded(): GoldenCoastPhase8FundedContainerState {
  const c = container();
  return {
    containerId: 20,
    companyId: 7,
    origin: "phase8",
    fundingVoucherId: 30,
    goodsCostUsd: "44000.00",
    reserveUsd: "22300.00",
    fundingAccount: c.fundingAccount,
    lines: c.lines,
  };
}

function cutoverFunded(): GoldenCoastPhase8FundedContainerState {
  const c = container();
  return {
    containerId: 21,
    companyId: 7,
    origin: "cutover",
    fundingVoucherId: 31,
    goodsCostUsd: "44000.00",
    // The migration never funds a reserve for a container it carries across.
    reserveUsd: "0.00",
    // The GC-OTW credit is the migration's OTW clearing account.
    fundingAccount: { kind: "ledger", id: 55 },
    lines: c.lines,
  };
}

describe("Golden Coast Phase 8 container/offload accounting", () => {
  it("plans the 44k container plus 22.3k real reserve", () => {
    const c = container();
    const plan = planGoldenCoastPhase8Funding(c);
    expect(plan.goodsCostUsd).toBe("44000.00");
    expect(plan.reserveUsd).toBe("22300.00");
    expect(plan.totalFundingUsd).toBe("66300.00");
    const posting = buildGoldenCoastPhase8FundingPosting({ container: c, plan, accounts });
    expect(posting.entries.map((entry) => [entry.debitAmount, entry.creditAmount])).toEqual([
      ["44000", "0"],
      ["22300", "0"],
      ["0", "66300"],
    ]);
  });

  it("capitalizes actual duty and transport and moves the unused 1600 to Hassan Savings", () => {
    const offload = parseGoldenCoastPhase8OffloadInput({
      companyId: 7,
      body: {
        clientRequestId: "phase8-offload-a",
        containerId: 20,
        locationId: 5,
        offloadDate: "2026-09-06",
        charges: [
          { chargeType: "duty", amountUsd: "8500" },
          { chargeType: "transport", amountUsd: "12200" },
        ],
      },
    });
    const plan = planGoldenCoastPhase8Offload({ offload, funded: funded() });
    expect(plan.actualChargesUsd).toBe("20700.00");
    expect(plan.unusedReserveUsd).toBe("1600.00");
    expect(plan.totalFinalCostUsd).toBe("64700.00");
    expect(plan.lines[0].baseUnitCostUsd).toBe("22.000000");
    // The landed column carries the charge allocation alone, exactly as the
    // pre-Golden-Coast offload route writes it to sp_stock_movements.
    expect(plan.lines[0].landedUnitCostUsd).toBe("10.350000");
    expect(plan.lines[0].finalUnitCostUsd).toBe("32.350000");
    const posting = buildGoldenCoastPhase8OffloadPosting({ offload, funded: funded(), plan, accounts });
    const debit = posting.entries.reduce((sum, entry) => sum + Number(entry.debitAmount), 0);
    const credit = posting.entries.reduce((sum, entry) => sum + Number(entry.creditAmount), 0);
    expect(debit).toBe(67900);
    expect(credit).toBe(67900);
  });


  it("funds Fresh Start invoice through OTW clearing without supplier, cash, or Hassan equity", () => {
    const input = parseGoldenCoastPhase8ContainerInput({
      companyId: 7,
      body: {
        clientRequestId: "freshstart-excel-1",
        supplierId: null,
        supplierName: "Fresh Start FZE",
        containerNumber: "MRKU2427063",
        invoiceNumber: "PO-2024-01119",
        invoiceDate: "2026-10-16",
        reserveUsd: "0",
        fundingAccount: { kind: "ledger", id: 55 },
        lines: [{ stockItemId: 1, articleCode: "BAG", qty: "2000", unitRateUsd: "22" }],
      },
    });
    const posting = buildGoldenCoastFreshStartExcelFundingPosting({
      container: input,
      invoiceTotalUsd: "47000.00",
      otwClearingAccountId: 55,
      stockOtwAccountId: 10,
    });
    expect(posting.source.sourceType).toBe("golden-coast-phase8-container");
    expect(posting.source.sourceId).toMatch(/fresh-start-excel:fund$/);
    expect(posting.entries).toHaveLength(2);
    expect(posting.entries[0].ledgerAccountId).toBe(10);
    expect(Number(posting.entries[0].debitAmount)).toBe(47000);
    expect(posting.entries[1].ledgerAccountId).toBe(55);
    expect(Number(posting.entries[1].creditAmount)).toBe(47000);
    expect(posting.entries.some((entry) => entry.supplierId != null || entry.bankAccountId != null)).toBe(false);
  });

  it("offloads Fresh Start invoice freight net of discount without double-charging or changing item price", () => {
    const state: GoldenCoastPhase8FundedContainerState = {
      ...cutoverFunded(),
      origin: "fresh_start_excel",
      goodsCostUsd: "47000.00",
    };
    const offload = parseGoldenCoastPhase8OffloadInput({
      companyId: 7,
      body: {
        clientRequestId: "freshstart-offload-1",
        containerId: 21,
        locationId: 5,
        offloadDate: "2026-10-16",
      },
    });
    const plan = planGoldenCoastPhase8Offload({ offload, funded: state });
    expect(plan.goodsCostUsd).toBe("47000.00");
    expect(plan.totalFinalCostUsd).toBe("47000.00");
    expect(plan.lines[0].baseUnitCostUsd).toBe("22.000000");
    expect(plan.lines[0].landedUnitCostUsd).toBe("1.500000");
    expect(plan.lines[0].finalUnitCostUsd).toBe("23.500000");
    const voucher = buildGoldenCoastPhase8OffloadPosting({ offload, funded: state, plan, accounts });
    expect(voucher.entries).toHaveLength(2);
    expect(voucher.entries[0].ledgerAccountId).toBe(11);
    expect(Number(voucher.entries[0].debitAmount)).toBe(47000);
    expect(voucher.entries[1].ledgerAccountId).toBe(10);
    expect(Number(voucher.entries[1].creditAmount)).toBe(47000);
  });

  it("rejects actual charges above the funded reserve", () => {
    const offload = parseGoldenCoastPhase8OffloadInput({
      companyId: 7,
      body: {
        clientRequestId: "phase8-over",
        containerId: 20,
        locationId: 5,
        offloadDate: "2026-09-06",
        charges: [{ chargeType: "duty", amountUsd: "22300.01" }],
      },
    });
    expect(() => planGoldenCoastPhase8Offload({ offload, funded: funded() })).toThrowError(GoldenCoastPhase8Error);
  });

  it("rejects pre-cutover container dates", () => {
    expect(() =>
      parseGoldenCoastPhase8ContainerInput({
        companyId: 7,
        body: {
          clientRequestId: "bad-date",
          supplierName: "Fresh Start",
          invoiceNumber: "x",
          invoiceDate: "2026-08-31",
          reserveUsd: "0",
          fundingAccount: { kind: "ledger", id: 99 },
          lines: [{ stockItemId: 1, articleCode: "BAG", qty: "1", unitRateUsd: "22" }],
        },
      })
    ).toThrow(/cutover/i);
  });

  it("settles a cutover container's charges against the named funding account", () => {
    const offload = parseGoldenCoastPhase8OffloadInput({
      companyId: 7,
      body: {
        clientRequestId: "phase8-cutover-a",
        containerId: 21,
        locationId: 5,
        offloadDate: "2026-09-06",
        charges: [{ chargeType: "duty", amountUsd: "3000" }],
        chargeFundingAccount: { kind: "bank", id: 77 },
      },
    });
    const plan = planGoldenCoastPhase8Offload({ offload, funded: cutoverFunded() });
    expect(plan.reserveUsd).toBe("0.00");
    expect(plan.actualChargesUsd).toBe("3000.00");
    // No reserve was ever funded, so there is nothing unused to sweep.
    expect(plan.unusedReserveUsd).toBe("0.00");
    expect(plan.totalFinalCostUsd).toBe("47000.00");
    expect(plan.lines[0].landedUnitCostUsd).toBe("1.500000");

    const posting = buildGoldenCoastPhase8OffloadPosting({
      offload,
      funded: cutoverFunded(),
      plan,
      accounts,
    });
    const debit = posting.entries.reduce((sum, entry) => sum + Number(entry.debitAmount), 0);
    const credit = posting.entries.reduce((sum, entry) => sum + Number(entry.creditAmount), 0);
    expect(debit).toBe(47000);
    expect(credit).toBe(47000);
    // The charges credit the named funding account, and neither the container
    // reserve nor the Hassan accounts are touched.
    expect(posting.entries.some((entry) => entry.bankAccountId === 77 && Number(entry.creditAmount) === 3000)).toBe(
      true
    );
    for (const untouched of [
      accounts.containerReserveAccountId,
      accounts.hassanEquityAccountId,
      accounts.hassanSavingsAccountId,
    ]) {
      expect(posting.entries.some((entry) => entry.ledgerAccountId === untouched)).toBe(false);
    }
  });

  it("offloads a cutover container with no charges at all", () => {
    const offload = parseGoldenCoastPhase8OffloadInput({
      companyId: 7,
      body: {
        clientRequestId: "phase8-cutover-b",
        containerId: 21,
        locationId: 5,
        offloadDate: "2026-09-06",
      },
    });
    const plan = planGoldenCoastPhase8Offload({ offload, funded: cutoverFunded() });
    expect(plan.actualChargesUsd).toBe("0.00");
    expect(plan.totalFinalCostUsd).toBe("44000.00");
    const posting = buildGoldenCoastPhase8OffloadPosting({ offload, funded: cutoverFunded(), plan, accounts });
    expect(posting.entries).toHaveLength(2);
  });

  it("refuses a cutover container with charges but no funding account", () => {
    const offload = parseGoldenCoastPhase8OffloadInput({
      companyId: 7,
      body: {
        clientRequestId: "phase8-cutover-c",
        containerId: 21,
        locationId: 5,
        offloadDate: "2026-09-06",
        charges: [{ chargeType: "transport", amountUsd: "500" }],
      },
    });
    expect(() => planGoldenCoastPhase8Offload({ offload, funded: cutoverFunded() })).toThrowError(
      /chargeFundingAccount is required/
    );
  });

  it("does not apply the reserve ceiling to a cutover container", () => {
    // The same charges would be rejected against a Phase 8 container funded
    // with a smaller reserve; a cutover container has no ceiling to exceed.
    const offload = parseGoldenCoastPhase8OffloadInput({
      companyId: 7,
      body: {
        clientRequestId: "phase8-cutover-d",
        containerId: 21,
        locationId: 5,
        offloadDate: "2026-09-06",
        charges: [{ chargeType: "other", amountUsd: "99000" }],
        chargeFundingAccount: { kind: "ledger", id: 88 },
      },
    });
    const plan = planGoldenCoastPhase8Offload({ offload, funded: cutoverFunded() });
    expect(plan.actualChargesUsd).toBe("99000.00");
  });

  it("uses a distinct FIFO provenance for post-cutover offloads", () => {
    expect(GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE).toBe("golden_coast_phase8_offload");
  });
});
