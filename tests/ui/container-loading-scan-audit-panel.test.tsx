/**
 * Behavioural coverage for the scan-audit line under each loaded bale.
 *
 * Audit metadata now travels on the order's bale rows, so the loading panel
 * does not issue a second growing request after every scan.
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ScannedBalesPanel } from "@/pages/factory/factorycontainerloadingscan/ScannedBalesPanel";
import type { FactoryContainerLoadingScanModel } from "@/pages/factory/factorycontainerloadingscan/useFactoryContainerLoadingScanModel";
import { translateFactoryContainerLoadingText } from "@/i18n/factoryContainerLoadingTranslations";

const BALES = [
  {
    id: 10,
    baleReference: "REF-10",
    baleName: "Shirts",
    articleCode: "A1",
    weight: "50",
    scannedBy: "loader",
    scannedAt: "2026-08-28T10:00:00.000Z",
  },
  {
    id: 11,
    baleReference: "REF-11",
    baleName: "Shirts",
    articleCode: "A1",
    weight: "48",
    scannedBy: "supervisor",
    scannedAt: "2026-08-28T11:30:00.000Z",
  },
];

function buildModel(bales = BALES): FactoryContainerLoadingScanModel {
  return {
    tr: (key: any, params?: Record<string, string | number>) =>
      translateFactoryContainerLoadingText(key, "en", params),
    orderId: 77,
    bales,
    totalWeight: bales.reduce((sum, bale) => sum + Number(bale.weight || 0), 0),
    viewMode: "detailed",
    lastScannedRef: null,
    scanFlash: null,
    scanCode: "",
    scanInputClass: "",
    selectedLocationId: 11,
    ignoreProforma: false,
    baleRemovals: [],
    showRemovalLog: false,
    orderedGroups: [{ articleCode: "A1", baleName: "Shirts", totalWeight: 98, bales }],
    scannerRef: { current: null },
    importFileRef: { current: null },
    addBaleMutation: { isPending: false },
    removeBaleMutation: { isPending: false },
    showEmptyContainerConfirm: false,
    setShowEmptyContainerConfirm: vi.fn(),
    emptyContainerMutation: { isPending: false, mutate: vi.fn() },
    setScanCode: vi.fn(),
    handleScan: vi.fn(),
    handleImportFile: vi.fn(),
    downloadTemplate: vi.fn(),
    toggleIgnoreProforma: vi.fn(),
    toggleGroup: vi.fn(),
    setViewMode: vi.fn(),
    setBaleToDelete: vi.fn(),
    setShowRemovalLog: vi.fn(),
  } as unknown as FactoryContainerLoadingScanModel;
}

function renderPanel(model = buildModel()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["/api/auth/me"], { role: "Admin", currentRole: "Admin" });
  return render(
    <QueryClientProvider client={client}>
      <ScannedBalesPanel model={model} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loaded bale scan audit", () => {
  it("shows who scanned each bale and when from the existing order payload", () => {
    renderPanel();

    expect(screen.getByTestId("text-bale-scan-audit-10")).toHaveTextContent("Scanned by loader");
    expect(screen.getByTestId("text-bale-scan-audit-11")).toHaveTextContent("Scanned by supervisor");

    const localised = new Date("2026-08-28T10:00:00.000Z").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(screen.getByTestId("text-bale-scan-audit-10")).toHaveTextContent(localised);
  });

  it("leaves legacy bales without trustworthy audit metadata blank", () => {
    renderPanel(
      buildModel([
        { ...BALES[0], scannedBy: null, scannedAt: null },
        { ...BALES[1], scannedBy: "supervisor", scannedAt: null },
      ])
    );

    expect(screen.queryByTestId("text-bale-scan-audit-10")).not.toBeInTheDocument();
    expect(screen.getByTestId("text-bale-scan-audit-11")).toHaveTextContent("Scanned by supervisor");
    expect(screen.getByTestId("text-bale-scan-audit-11").textContent).not.toContain("•");
  });

  it("does not perform a separate scan-audit fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
