import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContainerFormDialog } from "@/pages/factory/factory-containers/ContainerFormDialog";
import type { ContainerWithSupplier } from "@/pages/factory/factory-containers/otwHelpers";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/hooks/use-admin-override", () => ({
  useAdminOverride: () => ({ wrapAdminAction: (action: () => void) => action(), AdminDialog: null }),
}));
vi.mock("@/lib/factoryApi", () => ({
  factoryApiRequest: vi.fn(async () => ({ ok: true, json: async () => [] })),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/pages/factory/factory-containers/ContainerFormBody", () => ({
  ContainerFormBody: ({
    currency,
    fxRate,
    fxRateSource,
  }: {
    currency: string;
    fxRate: string;
    fxRateSource: string;
  }) => <output data-testid="loaded-container-fx">{`${currency}|${fxRateSource}|${fxRate}`}</output>,
}));

describe("factory container edit FX hydration", () => {
  it("preserves a stored manual rate when opening the editor from the initial USD form", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const container = {
      id: 812,
      containerNumber: "FX-MANUAL-812",
      currencyCode: "EUR",
      fxRateSource: "manual",
      fxRateToUsd: "1.18000000",
      fxRateDateImport: "2026-09-22",
      supplierId: 1,
      totalKg: "21770",
      ratePerKg: "0.34",
      status: "PENDING",
    } as ContainerWithSupplier;
    const props = {
      suppliers: [],
      ledgerAccounts: [],
      onClose: vi.fn(),
    };

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ContainerFormDialog open={false} editingContainer={null} {...props} />
      </QueryClientProvider>
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ContainerFormDialog open={true} editingContainer={container} {...props} />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("loaded-container-fx").textContent).toBe("EUR|manual|1.18");
    });
  });
});
