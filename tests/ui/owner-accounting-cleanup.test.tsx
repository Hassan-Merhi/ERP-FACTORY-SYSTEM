/**
 * Owner "Accounting clean-up" page: the ordered cards, the preview in figures,
 * Apply only after a clean preview with { confirm: true, planHash }, the
 * translated 409 PLAN_CHANGED message, and the rates-file import preview.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "./helpers";

const harness = vi.hoisted(() => ({
  apiRequestPrivileged: vi.fn(),
  apiRequest: vi.fn(),
  selectCompany: vi.fn(),
}));

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return {
    ...actual,
    apiRequestPrivileged: harness.apiRequestPrivileged,
    apiRequest: harness.apiRequest,
    getAppDate: () => "2026-10-11",
  };
});

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: 7, name: "Company Seven" },
    companies: [
      { id: 7, name: "Company Seven" },
      { id: 10, name: "Company Ten" },
    ],
    selectCompany: harness.selectCompany,
    isLoading: false,
    error: null,
  }),
}));

import AccountingCleanup, { cleanupStepsFor } from "@/pages/AccountingCleanup";

const HASH = "a".repeat(64);
const owner = {
  seedQueries: [[["/api/auth/me"], { id: "u1", username: "owner", role: "Owner", currentRole: "Owner" }]] as const,
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function refusal(status: number, code: string, message: string) {
  return new Refused(status, code, message);
}

/** Routes GET plan requests to fixtures; POSTs are recorded and answered by `onPost`. */
function serve(
  plans: Record<string, unknown>,
  onPost: (url: string, body: unknown) => unknown = () => ({ applied: true })
) {
  harness.apiRequestPrivileged.mockImplementation(async (method: string, url: string, body?: unknown) => {
    if (method === "GET") {
      if (!(url in plans)) throw refusal(404, "NOT_FOUND", `no fixture for ${url}`);
      return jsonResponse(plans[url]);
    }
    const answer = onPost(url, body);
    if (answer instanceof Error) throw answer;
    return jsonResponse(answer);
  });
}

beforeEach(() => {
  harness.apiRequestPrivileged.mockReset();
  harness.apiRequest.mockReset();
  window.history.replaceState({}, "", "/accounting-cleanup");
  (global as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
});

afterEach(() => {
  vi.clearAllMocks();
});

const plugPlan = {
  companyId: 7,
  settingKey: "equity_adjustment",
  stored: { id: 3, value: "-6300000.00", updatedAt: "2026-09-01" },
  storedValue: "-6300000.00",
  blockers: [],
  planHash: HASH,
  liveImportCycleDifference: "-6299950.25",
};

describe("Accounting clean-up page", () => {
  it("lists the fifteen steps in order, with the mode's tools only", async () => {
    renderWithProviders(<AccountingCleanup />, owner);
    const cards = await screen.findAllByTestId(/^card-cleanup-step-\d+$/);
    expect(cards.map((card) => card.getAttribute("data-testid"))).toEqual(
      Array.from({ length: 15 }, (_, index) => `card-cleanup-step-${index + 1}`)
    );
    expect(within(cards[0]).getByText("Required system accounts", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByTestId("tool-erp-prepaid-rent")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-factory-prepaid-rent")).toBeNull();
    expect(
      cleanupStepsFor("factory")
        .find((step) => step.step === 7)
        ?.tools.map((tool) => tool.key)
    ).toEqual(["factory-prepaid-rent"]);
    const goLive = (mode: "erp" | "factory") =>
      cleanupStepsFor(mode)
        .find((step) => step.step === 14)
        ?.tools.map((tool) => tool.key);
    expect(goLive("factory")).toEqual(expect.arrayContaining(["no-mix-bales", "bale-recost", "readiness-resolution"]));
    expect(goLive("factory")).not.toContain("bale-mirror-write-off");
    expect(goLive("erp")).toEqual(expect.arrayContaining(["bale-mirror-write-off", "readiness-resolution"]));
    expect(goLive("erp")).not.toContain("bale-recost");
    // Step 2 holds the dated company rates in ERP mode; nothing on the page posts the perpetual switch.
    expect(within(cards[1]).getByTestId("card-erp-exchange-rates")).toBeInTheDocument();
    expect(screen.getByTestId("text-step-company-4")).toHaveTextContent("Company Seven");
    expect(harness.apiRequestPrivileged).not.toHaveBeenCalled();
  });

  it("renders the plan's figures on preview and keeps Apply disabled until then", async () => {
    serve({ "/api/accounting/legacy-equity-plug/plan": plugPlan });
    renderWithProviders(<AccountingCleanup />, owner);
    const apply = await screen.findByTestId("button-apply-legacy-equity-plug");
    expect(apply).toBeDisabled();
    expect(screen.getByTestId("badge-status-legacy-equity-plug")).toHaveTextContent("Not started");

    fireEvent.click(screen.getByTestId("button-preview-legacy-equity-plug"));
    const figures = await screen.findByTestId("plan-figures-legacy-equity-plug");
    expect(figures).toHaveTextContent("Stored value");
    expect(figures).toHaveTextContent("-6300000.00");
    expect(figures).toHaveTextContent("Live import-cycle difference");
    expect(figures).toHaveTextContent("-6299950.25");
    expect(screen.getByTestId("badge-status-legacy-equity-plug")).toHaveTextContent("Previewed");
    expect(screen.getByTestId("button-apply-legacy-equity-plug")).toBeEnabled();
  });

  it("keeps Apply disabled for a plan with blockers or nothing to do", async () => {
    serve({
      "/api/accounting/stock-adjustment-inventory-mirror-reversal/plan?offset=OPENING_BALANCE_EQUITY": {
        companyId: 7,
        supplierPartner: false,
        vouchers: [{ voucherId: 4, voucherNumber: "SA-4" }],
        total: { vouchers: 1, lines: 2, inventoryDebit: "120.00", inventoryCredit: "0.00" },
        blockers: ["NOT_SUPPLIER_PARTNER"],
        planHash: HASH,
      },
      "/api/insurance/admin/journal-direction/plan": { companyId: 7, candidates: [], skipped: [], planHash: HASH },
    });
    renderWithProviders(<AccountingCleanup />, owner);

    fireEvent.click(await screen.findByTestId("button-preview-backfill-reversal"));
    expect(await screen.findByTestId("blockers-backfill-reversal")).toHaveTextContent(
      "This company is not a supplier partner"
    );
    expect(screen.getByTestId("badge-status-backfill-reversal")).toHaveTextContent("Blocked");
    expect(screen.getByTestId("button-apply-backfill-reversal")).toBeDisabled();

    fireEvent.click(screen.getByTestId("button-preview-insurance-direction"));
    await waitFor(() =>
      expect(screen.getByTestId("badge-status-insurance-direction")).toHaveTextContent("Nothing to do")
    );
    expect(screen.getByTestId("button-apply-insurance-direction")).toBeDisabled();
  });

  it("applies the reviewed plan with confirm and planHash after the confirmation repeats the totals", async () => {
    const posted: Array<[string, unknown]> = [];
    serve({ "/api/accounting/legacy-equity-plug/plan": plugPlan }, (url, body) => {
      posted.push([url, body]);
      return { applied: true, plan: plugPlan };
    });
    renderWithProviders(<AccountingCleanup />, owner);
    fireEvent.click(await screen.findByTestId("button-preview-legacy-equity-plug"));
    await screen.findByTestId("plan-figures-legacy-equity-plug");
    fireEvent.click(screen.getByTestId("button-apply-legacy-equity-plug"));
    expect(await screen.findByTestId("confirm-figures-legacy-equity-plug")).toHaveTextContent("-6300000.00");
    fireEvent.click(screen.getByTestId("button-confirm-apply-legacy-equity-plug"));
    await screen.findByTestId("result-legacy-equity-plug");
    expect(posted).toEqual([["/api/accounting/legacy-equity-plug/apply", { confirm: true, planHash: HASH }]]);
    expect(screen.getByTestId("badge-status-legacy-equity-plug")).toHaveTextContent("Applied");
    expect(screen.getByTestId("button-apply-legacy-equity-plug")).toBeDisabled();
  });

  it("sends the tool's own fields and links the vouchers it posted", async () => {
    const posted: Array<[string, unknown]> = [];
    serve(
      {
        "/api/accounting/fx-revaluation/preview?monthEnd=2026-09-30": {
          companyId: 7,
          monthEnd: "2026-09-30",
          reversalDate: "2026-10-01",
          lines: [{ label: "Bank EUR", currency: "EUR", adjustment: "12.50" }],
          skipped: [{ label: "Bank AUD", currency: "AUD", reason: "RATE_MISSING" }],
          totals: { gain: "12.50", loss: "0.00", net: "12.50" },
          alreadyApplied: null,
          planHash: HASH,
        },
      },
      (url, body) => {
        posted.push([url, body]);
        return {
          applied: true,
          voucherId: 91,
          voucherNumber: "JV-FX-0001",
          reversalVoucherId: 92,
          reversalVoucherNumber: "JV-FX-0002",
        };
      }
    );
    renderWithProviders(<AccountingCleanup />, owner);
    expect(await screen.findByTestId("button-preview-fx-revaluation")).toBeDisabled();
    fireEvent.change(screen.getByTestId("input-fx-revaluation-month-end"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByTestId("button-preview-fx-revaluation"));
    expect(await screen.findByTestId("plan-figures-fx-revaluation-skipped")).toHaveTextContent("RATE_MISSING");
    fireEvent.click(screen.getByTestId("button-apply-fx-revaluation"));
    fireEvent.click(await screen.findByTestId("button-confirm-apply-fx-revaluation"));
    const vouchers = await screen.findByTestId("result-vouchers-fx-revaluation");
    expect(posted).toEqual([
      ["/api/accounting/fx-revaluation/apply", { confirm: true, planHash: HASH, monthEnd: "2026-09-30" }],
    ]);
    expect(within(vouchers).getByText("JV-FX-0001").closest("a")).toHaveAttribute("href", "/voucher-detail/91");
    expect(within(vouchers).getByText("JV-FX-0002")).toBeInTheDocument();
  });

  it("explains a 409 PLAN_CHANGED and asks for a new preview", async () => {
    serve({ "/api/accounting/legacy-equity-plug/plan": plugPlan }, () =>
      refusal(
        409,
        "PLAN_CHANGED",
        "The stored equity adjustment changed since it was reviewed; review it again before clearing."
      )
    );
    renderWithProviders(<AccountingCleanup />, owner);
    fireEvent.click(await screen.findByTestId("button-preview-legacy-equity-plug"));
    await screen.findByTestId("plan-figures-legacy-equity-plug");
    fireEvent.click(screen.getByTestId("button-apply-legacy-equity-plug"));
    fireEvent.click(await screen.findByTestId("button-confirm-apply-legacy-equity-plug"));
    const error = await screen.findByTestId("error-legacy-equity-plug");
    expect(error).toHaveTextContent("The data changed since the preview. Preview again");
    expect(screen.getByTestId("button-apply-legacy-equity-plug")).toBeDisabled();
  });

  it("refuses to apply a plan the server built for another company", async () => {
    serve({ "/api/accounting/legacy-equity-plug/plan": { ...plugPlan, companyId: 10 } });
    renderWithProviders(<AccountingCleanup />, owner);
    fireEvent.click(await screen.findByTestId("button-preview-legacy-equity-plug"));
    expect(await screen.findByTestId("warning-company-legacy-equity-plug")).toHaveTextContent("company #10");
    expect(screen.getByTestId("button-apply-legacy-equity-plug")).toBeDisabled();
  });

  it("lets an Admin preview but not apply an Owner-only tool", async () => {
    serve({ "/api/accounting/legacy-equity-plug/plan": plugPlan });
    renderWithProviders(<AccountingCleanup />, {
      seedQueries: [[["/api/auth/me"], { id: "u2", username: "admin", role: "Admin", currentRole: "Admin" }]],
    });
    fireEvent.click(await screen.findByTestId("button-preview-legacy-equity-plug"));
    await screen.findByTestId("plan-figures-legacy-equity-plug");
    expect(screen.getByTestId("button-apply-legacy-equity-plug")).toBeDisabled();
    expect(screen.getByTestId("button-preview-insurance-direction")).toBeDisabled();
  });
});
