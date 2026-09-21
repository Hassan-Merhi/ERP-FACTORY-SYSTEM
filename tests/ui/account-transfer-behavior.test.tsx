import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "./helpers";

const harness = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: {
      id: 1,
      name: "Test Co",
      code: "TC",
      active: true,
      companyType: "erp" as const,
    },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));

import AccountTransfer from "@/pages/AccountTransfer";

const accounts = [
  { id: 11, name: "Cash", code: "1000", accountType: "Asset" },
  { id: 22, name: "Clearing", code: "1090", accountType: "Asset" },
];

function responseJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

function entryPage(page: number, search = "") {
  const firstId = page === 1 ? 101 : 201;
  return {
    items: [
      {
        id: firstId,
        voucherId: firstId + 1000,
        narration: search ? `Matched ${search}` : `Entry ${firstId}`,
        debitAmount: "125.50",
        creditAmount: "0.00",
        voucherNumber: `JV-${firstId}`,
        voucherType: "Journal",
        voucherDate: "2026-08-20",
        voucherDescription: "Transfer candidate",
      },
    ],
    total: 150,
    page,
    pageSize: 100,
    totalPages: 2,
    hasNextPage: page < 2,
    hasPreviousPage: page > 1,
  };
}

function installFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input.toString();
    const url = new URL(raw, "http://localhost");
    if (url.pathname.startsWith("/api/voucher-entries/by-account/")) {
      return responseJson(entryPage(Number(url.searchParams.get("page") || 1), url.searchParams.get("search") || ""));
    }
    return responseJson([]);
  });
  window.fetch = fetchMock as unknown as typeof window.fetch;
  return fetchMock;
}

function renderPage() {
  return renderWithProviders(<AccountTransfer />, {
    seedQueries: [[["/api/ledger-accounts?profile=picker"], accounts]],
  });
}

async function selectSourceAccount() {
  fireEvent.click(screen.getByTestId("combobox-from-account"));
  fireEvent.click(await screen.findByTestId("combobox-from-account-option-11"));
  await screen.findByTestId("row-entry-101");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("account transfer behavior", () => {
  it("loads the selected account with bounded server-side pagination", async () => {
    const fetchMock = installFetch();
    renderPage();

    await selectSourceAccount();

    const statementCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/voucher-entries/by-account/11")
    );
    expect(statementCall).toBeDefined();
    const url = new URL(String(statementCall?.[0]), "http://localhost");
    expect(Number(url.searchParams.get("pagination"))).toBe(1);
    expect(Number(url.searchParams.get("page"))).toBe(1);
    expect(Number(url.searchParams.get("pageSize"))).toBe(100);
    expect(screen.getByTestId("button-entries-previous-page")).toBeDisabled();
    expect(screen.getByTestId("button-entries-next-page")).not.toBeDisabled();
  });

  it("requests the next server page and replaces the visible entry", async () => {
    installFetch();
    renderPage();
    await selectSourceAccount();

    fireEvent.click(screen.getByTestId("button-entries-next-page"));

    expect(await screen.findByTestId("row-entry-201")).toBeInTheDocument();
    expect(screen.queryByTestId("row-entry-101")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-entries-previous-page")).not.toBeDisabled();
    expect(screen.getByTestId("button-entries-next-page")).toBeDisabled();
  });

  it("resets paging and sends the trimmed entry search to the server", async () => {
    const fetchMock = installFetch();
    renderPage();
    await selectSourceAccount();
    fireEvent.click(screen.getByTestId("button-entries-next-page"));
    await screen.findByTestId("row-entry-201");

    fireEvent.change(screen.getByTestId("input-search-entries"), {
      target: { value: "  invoice  " },
    });

    await waitFor(() => {
      const matching = fetchMock.mock.calls
        .map(([input]) => new URL(String(input), "http://localhost"))
        .find((url) => url.searchParams.get("search") === "invoice");
      expect(matching).toBeDefined();
      expect(Number(matching?.searchParams.get("page"))).toBe(1);
    });
  });

  it("clears selected entries when changing pages", async () => {
    installFetch();
    renderPage();
    await selectSourceAccount();

    fireEvent.click(screen.getByTestId("checkbox-entry-101"));
    expect(screen.getByTestId("button-clear-selection")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-entries-next-page"));
    await screen.findByTestId("row-entry-201");
    expect(screen.queryByTestId("button-clear-selection")).not.toBeInTheDocument();
  });

  it("requires a destination before enabling the transfer action", async () => {
    installFetch();
    renderPage();
    await selectSourceAccount();

    fireEvent.click(screen.getByTestId("checkbox-entry-101"));
    const execute = screen.getByTestId("button-execute-transfer") as HTMLButtonElement;
    expect(execute.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("combobox-to-account"));
    fireEvent.click(await screen.findByTestId("combobox-to-account-option-22"));
    expect(execute.disabled).toBe(false);
  });
});
