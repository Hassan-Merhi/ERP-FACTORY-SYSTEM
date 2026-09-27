import React from "react";
import { cleanup, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { renderWithProviders, stubFetch } from "./helpers";

/**
 * Factory mounts the shared voucher detail page at /factory/voucher-detail/:voucherId. The page
 * used to match only the un-prefixed ERP path, so every Factory voucher showed "Invalid voucher ID".
 */

const mode = vi.hoisted(() => ({ value: "factory" as "erp" | "factory" }));

vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => mode.value,
  useModePrefix: () => (mode.value === "factory" ? "/factory" : ""),
  AppModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getModePrefix: (value: string) => (value === "factory" ? "/factory" : ""),
}));

vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ formatAmount: (value: unknown) => String(value ?? "") }),
}));

vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({ formatShortDate: (value: unknown) => String(value ?? "") }),
}));

beforeEach(() => stubFetch());
afterEach(() => {
  cleanup();
  mode.value = "factory";
});

async function renderAt(path: string) {
  const { default: VoucherDetail } = await import("@/pages/VoucherDetail");
  const { hook } = memoryLocation({ path });
  renderWithProviders(
    <Router hook={hook}>
      <VoucherDetail />
    </Router>
  );
}

describe("voucher detail route", () => {
  it("reads the voucher id under the Factory prefix", async () => {
    await renderAt("/factory/voucher-detail/2");
    expect(screen.queryByText("Invalid voucher ID")).not.toBeInTheDocument();
  });

  it("still reads the voucher id on the ERP path", async () => {
    mode.value = "erp";
    await renderAt("/voucher-detail/2");
    expect(screen.queryByText("Invalid voucher ID")).not.toBeInTheDocument();
  });

  it("reports an invalid id when the path has none", async () => {
    await renderAt("/factory/voucher-detail/");
    expect(screen.getByText("Invalid voucher ID")).toBeInTheDocument();
  });
});
