/**
 * Golden Coast Phase 12 — hub behaviour.
 *
 * Exercises what each phase panel actually sends: the approved endpoints, the
 * server-reported caps, the sensitive-action gates, and the absence of any
 * client-supplied accounting total. Assertions are on rendered output and on
 * request payloads, so the panels can be moved between files freely.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  toast: vi.fn(),
  apiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
  company: { id: 42, name: "Golden Coast", companyType: "supplier_partner" } as Record<string, unknown> | null,
  readiness: new Map<string, unknown>(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const url = String(queryKey?.[0] ?? "");
    for (const [prefix, data] of harness.readiness.entries()) {
      if (url.startsWith(prefix)) return { data, isLoading: false, error: null };
    }
    return { data: undefined, isLoading: false, error: null };
  },
  useMutation: (config: any) => ({
    isPending: false,
    mutate: vi.fn(async () => {
      try {
        const result = await config.mutationFn();
        config.onSuccess?.(result);
        return result;
      } catch (error) {
        config.onError?.(error);
      }
    }),
  }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: harness.company }),
}));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { invalidateQueries: harness.invalidateQueries },
}));

import SpGoldenCoast from "@/pages/sp/SpGoldenCoast";
import { EquitySalesCashPanel } from "@/pages/sp/golden-coast/EquitySalesCashPanel";
import { GcSalesCashPanel } from "@/pages/sp/golden-coast/GcSalesCashPanel";
import { HadiCashRoutingPanel } from "@/pages/sp/golden-coast/HadiCashRoutingPanel";
import { HassanSavingsPanel } from "@/pages/sp/golden-coast/HassanSavingsPanel";
import { MonthlyClosePanel } from "@/pages/sp/golden-coast/MonthlyClosePanel";

const PHASE7 = "/api/sp/golden-coast/phase7/sales-cash-transfer";
const PHASE9 = "/api/sp/golden-coast/phase9/hassan-savings-withdrawal";
const PHASE10 = "/api/sp/golden-coast/phase10/sales-cash-settlement";
const PHASE11 = "/api/sp/golden-coast/phase11/profit-splits/monthly-close";
const EQUITY_SALES_CASH = "/api/sp/golden-coast/equity-sales-cash-settlement";

/** Last body sent through apiRequest, with the URL it was sent to. */
function lastRequest(): { method: string; url: string; body: any } {
  const call = harness.apiRequest.mock.calls.at(-1);
  return { method: call?.[0], url: call?.[1], body: call?.[2] };
}

function setValue(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

beforeEach(() => {
  harness.toast.mockClear();
  harness.invalidateQueries.mockClear();
  harness.apiRequest.mockReset();
  harness.apiRequest.mockResolvedValue({ json: async () => ({ replayed: false }) });
  harness.company = { id: 42, name: "Golden Coast", companyType: "supplier_partner" };
  harness.readiness.clear();
  window.history.replaceState({}, "", "/sp/golden-coast");
});

describe("Golden Coast operations hub", () => {
  it("asks for a Supplier Partner company before showing any workflow", () => {
    harness.company = { id: 9, name: "Fresh Start", companyType: "erp" };
    render(<SpGoldenCoast />);

    expect(screen.getByText(/Select a Supplier Partner company/i)).toBeTruthy();
    expect(screen.queryByTestId("tabs-golden-coast")).toBeNull();
  });

  it("keeps Phase 6 sales on the existing POS workflow rather than a new sale endpoint", () => {
    render(<SpGoldenCoast />);

    expect(screen.getByTestId("link-gc-pos").getAttribute("href")).toBe("/pos");
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("refreshes readiness from the server instead of recomputing balances locally", () => {
    render(<SpGoldenCoast />);
    fireEvent.click(screen.getByTestId("button-gc-refresh-readiness"));

    expect(harness.invalidateQueries).toHaveBeenCalled();
  });
});

describe("Phase 7 HADI cash routing", () => {
  const readiness = {
    pair: {
      goldenCoastCompanyId: 42,
      goldenCoastCompanyName: "Golden Coast",
      hadiCompanyId: 77,
      hadiCompanyName: "HADI",
    },
    accounts: null,
    balances: { gcSalesCashPayableBalanceUsd: "500.00", outstandingHadiCollectionsUsd: "120.00" },
    hadiCashAccounts: [{ kind: "ledger", id: 11, name: "HADI Cash", type: "cash" }],
    goldenCoastCashAccounts: [{ kind: "bank", id: 22, name: "GC Bank", type: "bank" }],
    blockers: [],
    canTransfer: true,
  };

  beforeEach(() => {
    harness.readiness.set(`${PHASE7}/readiness`, readiness);
  });

  it("posts a collection through the target-company gate with the chosen HADI account", async () => {
    render(<HadiCashRoutingPanel companyKey={42} />);
    setValue("input-gc-phase7-amount", "250");
    fireEvent.click(screen.getByTestId("button-gc-phase7-submit"));

    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalled());
    const request = lastRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${PHASE7}?targetCompanyId=77`);
    expect(request.body.operation).toBe("collect_via_hadi");
    expect(request.body.amountUsd).toBe("250");
    expect(request.body.hadiCashAccount).toEqual({ kind: "ledger", id: 11 });
    expect(request.body.goldenCoastCashAccount).toBeUndefined();
    expect(request.body.clientRequestId).toMatch(/^gc-p7:/);
  });

  it("adds the receiving Golden Coast account only when HADI remits cash back", async () => {
    render(<HadiCashRoutingPanel companyKey={42} />);
    fireEvent.change(screen.getByLabelText(/Operation/i), { target: { value: "remit_from_hadi" } });
    setValue("input-gc-phase7-amount", "100");
    fireEvent.click(screen.getByTestId("button-gc-phase7-submit"));

    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalled());
    expect(lastRequest().body).toMatchObject({
      operation: "remit_from_hadi",
      goldenCoastCashAccount: { kind: "bank", id: 22 },
    });
  });

  it("refuses a remittance above the unremitted collections the server reports", () => {
    render(<HadiCashRoutingPanel companyKey={42} />);
    fireEvent.change(screen.getByLabelText(/Operation/i), { target: { value: "remit_from_hadi" } });
    setValue("input-gc-phase7-amount", "120.01");

    expect(screen.getByTestId("button-gc-phase7-submit").hasAttribute("disabled")).toBe(true);
  });

  it("does not cap a collection against the GC Sales Cash payable it raises", () => {
    render(<HadiCashRoutingPanel companyKey={42} />);
    setValue("input-gc-phase7-amount", "500.01");

    expect(screen.getByTestId("button-gc-phase7-submit").hasAttribute("disabled")).toBe(false);
  });

  it("stays blocked while the server reports the pair cannot transfer", () => {
    harness.readiness.set(`${PHASE7}/readiness`, { ...readiness, canTransfer: false, blockers: ["No pair"] });
    render(<HadiCashRoutingPanel companyKey={42} />);
    setValue("input-gc-phase7-amount", "10");

    expect(screen.getByText("No pair")).toBeTruthy();
    expect(screen.getByTestId("button-gc-phase7-submit").hasAttribute("disabled")).toBe(true);
  });
});

describe("Phase 9 Hassan Savings withdrawal", () => {
  beforeEach(() => {
    harness.readiness.set(`${PHASE9}/readiness`, {
      ready: true,
      companyId: 42,
      hassanSavingsAccount: { id: 5, name: "Hassan Savings" },
      availableSavingsUsd: "800.00",
      paymentAccounts: [{ kind: "ledger", id: 31, name: "GC Cash", type: "cash" }],
      sourceType: "ledger",
    });
  });

  function fillWithdrawal(): void {
    setValue("input-gc-phase9-amount", "300");
    setValue("input-gc-phase9-reason", "Owner distribution");
    setValue("input-gc-phase9-confirmation", "WITHDRAW HASSAN SAVINGS");
  }

  it("withdraws only after the reason and the exact confirmation phrase are present", async () => {
    render(<HassanSavingsPanel companyKey={42} />);
    setValue("input-gc-phase9-amount", "300");
    expect(screen.getByTestId("button-gc-phase9-submit").hasAttribute("disabled")).toBe(true);

    setValue("input-gc-phase9-reason", "Owner distribution");
    setValue("input-gc-phase9-confirmation", "withdraw hassan savings");
    expect(screen.getByTestId("button-gc-phase9-submit").hasAttribute("disabled")).toBe(true);

    setValue("input-gc-phase9-confirmation", "WITHDRAW HASSAN SAVINGS");
    fireEvent.click(screen.getByTestId("button-gc-phase9-submit"));

    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalled());
    const request = lastRequest();
    expect(request.url).toBe(PHASE9);
    expect(request.body).toMatchObject({
      amountUsd: "300",
      paymentAccount: { kind: "ledger", id: 31 },
      reason: "Owner distribution",
      confirmation: "WITHDRAW HASSAN SAVINGS",
    });
  });

  it("caps the withdrawal at the live available savings balance", () => {
    render(<HassanSavingsPanel companyKey={42} />);
    fillWithdrawal();
    setValue("input-gc-phase9-amount", "800.01");

    expect(screen.getByTestId("button-gc-phase9-submit").hasAttribute("disabled")).toBe(true);
  });

  it("shows the available balance the server reported", () => {
    render(<HassanSavingsPanel companyKey={42} />);

    expect(screen.getByText("$800.00")).toBeTruthy();
  });
});

describe("Phase 10 GC Sales Cash settlement", () => {
  beforeEach(() => {
    harness.readiness.set(`${PHASE10}/readiness`, {
      ready: true,
      companyId: 42,
      gcSalesCashAccount: { id: 8, name: "GC Sales Cash" },
      settleableSalesCashUsd: "400.00",
      rawSalesCashPayableBalanceUsd: "650.00",
      sharedChargesAccount: { id: 9, name: "Shared Charges" },
      receiptAccounts: [{ kind: "bank", id: 44, name: "GC Bank", type: "bank" }],
      sourceType: "ledger",
    });
  });

  it("settles into the approved receipt account", async () => {
    render(<GcSalesCashPanel companyKey={42} />);
    setValue("input-gc-phase10-amount", "400");
    fireEvent.click(screen.getByTestId("button-gc-phase10-submit"));

    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalled());
    const request = lastRequest();
    expect(request.url).toBe(PHASE10);
    expect(request.body).toMatchObject({
      amountUsd: "400",
      transferFeeUsd: "0",
      receiptAccount: { kind: "bank", id: 44 },
    });
  });

  it("pays no more than the settleable payable", () => {
    render(<GcSalesCashPanel companyKey={42} />);
    setValue("input-gc-phase10-amount", "650");

    expect(screen.getByTestId("button-gc-phase10-submit").hasAttribute("disabled")).toBe(true);
  });

  it("sends a transfer fee on top of the settlement without shrinking it", async () => {
    render(<GcSalesCashPanel companyKey={42} />);
    setValue("input-gc-phase10-amount", "400");
    setValue("input-gc-phase10-transfer-fee", "12.50");
    fireEvent.click(screen.getByTestId("button-gc-phase10-submit"));

    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalled());
    expect(lastRequest().body).toMatchObject({ amountUsd: "400", transferFeeUsd: "12.50" });
  });

  it("blocks a transfer fee when the server reports no Shared Charges account", () => {
    harness.readiness.set(`${PHASE10}/readiness`, {
      ...(harness.readiness.get(`${PHASE10}/readiness`) as Record<string, unknown>),
      sharedChargesAccount: null,
    });
    render(<GcSalesCashPanel companyKey={42} />);
    setValue("input-gc-phase10-amount", "400");
    setValue("input-gc-phase10-transfer-fee", "12.50");

    expect(screen.getByTestId("button-gc-phase10-submit").hasAttribute("disabled")).toBe(true);
  });
});

describe("GC Sales Cash settled from Hassan equity", () => {
  beforeEach(() => {
    harness.readiness.set(`${EQUITY_SALES_CASH}/readiness`, {
      ready: true,
      companyId: 42,
      gcSalesCashAccount: { id: 8, name: "GC Sales Cash" },
      hassanEquityAccount: { id: 2, name: "Hassan Dakik Equity" },
      freshStartEquityAccount: { id: 1, name: "Fresh Start FZ Equity" },
      payableSalesCashUsd: "900.00",
      availableHassanEquityUsd: "500.00",
      freshStartEquityUsd: "100000.00",
      maxSettlementUsd: "500.00",
      sourceType: "ledger",
    });
  });

  function fillSettlement(): void {
    setValue("input-gc-equity-sales-cash-amount", "500");
    setValue("input-gc-equity-sales-cash-confirmation", "SETTLE SALES CASH FROM EQUITY");
  }

  it("posts the amount, reason and confirmation and never a payment account", async () => {
    render(<EquitySalesCashPanel companyKey={42} />);
    fillSettlement();
    setValue("input-gc-equity-sales-cash-reason", "Hassan settles from capital");
    fireEvent.click(screen.getByTestId("button-gc-equity-sales-cash-submit"));

    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalled());
    const request = lastRequest();
    expect(request.url).toBe(EQUITY_SALES_CASH);
    expect(request.body).toMatchObject({
      amountUsd: "500",
      reason: "Hassan settles from capital",
      confirmation: "SETTLE SALES CASH FROM EQUITY",
    });
    // No money moves, so the panel must never name a cash or bank target.
    expect(request.body.paymentAccount).toBeUndefined();
    expect(request.body.receiptAccount).toBeUndefined();
    // The 2x Fresh Start credit is the server's to derive, never the client's.
    expect(request.body.freshStartEquityCreditUsd).toBeUndefined();
  });

  it("stays disabled without a reason and the exact confirmation phrase", () => {
    render(<EquitySalesCashPanel companyKey={42} />);
    setValue("input-gc-equity-sales-cash-amount", "500");
    expect(screen.getByTestId("button-gc-equity-sales-cash-submit").hasAttribute("disabled")).toBe(true);

    setValue("input-gc-equity-sales-cash-reason", "Hassan settles from capital");
    setValue("input-gc-equity-sales-cash-confirmation", "settle sales cash from equity");
    expect(screen.getByTestId("button-gc-equity-sales-cash-submit").hasAttribute("disabled")).toBe(true);

    setValue("input-gc-equity-sales-cash-confirmation", "SETTLE SALES CASH FROM EQUITY");
    expect(screen.getByTestId("button-gc-equity-sales-cash-submit").hasAttribute("disabled")).toBe(false);
  });

  it("caps at the lower of the payable and Hassan's available equity", () => {
    render(<EquitySalesCashPanel companyKey={42} />);
    fillSettlement();
    setValue("input-gc-equity-sales-cash-reason", "Hassan settles from capital");
    // The payable is 900 but only 500 of equity is available.
    setValue("input-gc-equity-sales-cash-amount", "500.01");

    expect(screen.getByTestId("button-gc-equity-sales-cash-submit").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("text-gc-equity-sales-cash-max").textContent).toBe("$500.00");
  });
});

describe("Phase 11 monthly 50/50 close", () => {
  beforeEach(() => {
    harness.readiness.set(`${PHASE11}/readiness`, {
      ready: true,
      alreadyClosed: false,
      plan: {
        periodMonth: "2026-07",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        totalRevenueUsd: "1000.00",
        totalCogsUsd: "400.00",
        totalSharedChargesUsd: "100.00",
        netProfitLossUsd: "500.00",
        freshStartShareUsd: "250.00",
        hassanShareUsd: "250.00",
      },
      profitPendingDistributionBalanceUsd: "500.00",
    });
  });

  it("submits the month, reason, and confirmation without any client-side accounting total", async () => {
    render(<MonthlyClosePanel companyKey={42} />);
    setValue("input-gc-phase11-month", "2026-07");
    setValue("input-gc-phase11-reason", "July close");
    setValue("input-gc-phase11-confirmation", "FINALIZE SP PROFIT SPLIT");
    fireEvent.click(screen.getByTestId("button-gc-phase11-submit"));

    await waitFor(() => expect(harness.apiRequest).toHaveBeenCalled());
    const request = lastRequest();
    expect(request.url).toBe(PHASE11);
    expect(request.body).toMatchObject({
      periodMonth: "2026-07",
      reason: "July close",
      confirmation: "FINALIZE SP PROFIT SPLIT",
    });
    expect(request.body.idempotencyKey).toBe(request.body.clientRequestId);
    expect(Object.keys(request.body)).toEqual(
      expect.not.arrayContaining(["splitPct", "totalRevenueUsd", "totalCogsUsd", "totalSharedChargesUsd"])
    );
  });

  it("renders the server-derived shares rather than splitting the net locally", () => {
    render(<MonthlyClosePanel companyKey={42} />);

    expect(screen.getAllByText("$250.00").length).toBe(2);
    expect(screen.getByText("$1,000.00")).toBeTruthy();
  });

  it("refuses to close a month the server already closed", () => {
    harness.readiness.set(`${PHASE11}/readiness`, { ready: false, alreadyClosed: true });
    render(<MonthlyClosePanel companyKey={42} />);
    setValue("input-gc-phase11-reason", "July close");
    setValue("input-gc-phase11-confirmation", "FINALIZE SP PROFIT SPLIT");

    expect(screen.getByText(/already closed/i)).toBeTruthy();
    expect(screen.getByTestId("button-gc-phase11-submit").hasAttribute("disabled")).toBe(true);
  });
});
