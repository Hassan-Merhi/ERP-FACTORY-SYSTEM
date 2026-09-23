/**
 * Behavioural coverage for the scan-audit line under each loaded bale.
 *
 * The panel asks the existing bale-removals endpoint for the audit rows and
 * renders, under the bale reference, who scanned it and when. Three things
 * matter to whoever reads the loading list:
 *
 *   - the scanner's name and the scan time appear under the right bale;
 *   - a bale scanned before the feature shipped has no trustworthy time, so it
 *     shows nothing rather than an invented date;
 *   - the audit is opt-in on the shared route, so the request carries
 *     `includeScanAudit=1` and the panel still renders if it comes back empty.
 *
 * The panel is rendered with a real query client against a stubbed `fetch`, so
 * the request it makes and the markup it produces are both observable.
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScannedBalesPanel } from "@/pages/factory/factorycontainerloadingscan/ScannedBalesPanel";
import type { FactoryContainerLoadingScanModel } from "@/pages/factory/factorycontainerloadingscan/useFactoryContainerLoadingScanModel";
import { translateFactoryContainerLoadingText } from "@/i18n/factoryContainerLoadingTranslations";

const BALES = [
  { id: 10, baleReference: "REF-10", baleName: "Shirts", articleCode: "A1", weight: "50" },
  { id: 11, baleReference: "REF-11", baleName: "Shirts", articleCode: "A1", weight: "48" },
];

function buildModel(): FactoryContainerLoadingScanModel {
  return {
    tr: (key: any, params?: Record<string, string | number>) => translateFactoryContainerLoadingText(key, "en", params),
    orderId: 77,
    bales: BALES,
    totalWeight: 98,
    viewMode: "detailed",
    lastScannedRef: null,
    scanFlash: null,
    scanCode: "",
    scanInputClass: "",
    selectedLocationId: 11,
    ignoreProforma: false,
    baleRemovals: [],
    showRemovalLog: false,
    orderedGroups: [{ articleCode: "A1", baleName: "Shirts", totalWeight: 98, bales: BALES }],
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

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScannedBalesPanel model={buildModel()} />
    </QueryClientProvider>
  );
}

function respondWith(scanAudit: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ scanAudit }) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loaded bale scan audit", () => {
  it("shows who scanned each bale and when, under that bale's reference", async () => {
    respondWith([
      { id: 10, scannedBy: "loader", scannedAt: "2026-08-28T10:00:00.000Z" },
      { id: 11, scannedBy: "supervisor", scannedAt: "2026-08-28T11:30:00.000Z" },
    ]);

    renderPanel();

    await waitFor(() => expect(screen.getByTestId("text-bale-scan-audit-10")).toBeInTheDocument());
    expect(screen.getByTestId("text-bale-scan-audit-10")).toHaveTextContent("Scanned by loader");
    expect(screen.getByTestId("text-bale-scan-audit-11")).toHaveTextContent("Scanned by supervisor");

    // Rendered in the reader's own timezone, so assert on the formatting the
    // browser would produce rather than a fixed string.
    const localised = new Date("2026-08-28T10:00:00.000Z").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(screen.getByTestId("text-bale-scan-audit-10")).toHaveTextContent(localised);
  });

  it("requests the audit as an opt-in on the shared bale-removals route", async () => {
    const fetchMock = respondWith([]);

    renderPanel();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/factory/customer-orders/77/bale-removals?includeScanAudit=1");
  });

  it("leaves a bale scanned before the feature shipped blank instead of inventing a date", async () => {
    respondWith([
      { id: 10, scannedBy: null, scannedAt: null },
      { id: 11, scannedBy: "supervisor", scannedAt: null },
    ]);

    renderPanel();

    await waitFor(() => expect(screen.getByTestId("text-bale-scan-audit-11")).toBeInTheDocument());
    expect(screen.queryByTestId("text-bale-scan-audit-10")).not.toBeInTheDocument();
    expect(screen.getByTestId("text-bale-scan-audit-11")).toHaveTextContent("Scanned by supervisor");
    expect(screen.getByTestId("text-bale-scan-audit-11").textContent).not.toContain("•");
  });

  it("still lists the bales when the audit lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    );

    renderPanel();

    expect(screen.getByTestId("text-bale-ref-10")).toHaveTextContent("REF-10");
    await waitFor(() => expect(screen.queryByTestId("text-bale-scan-audit-10")).not.toBeInTheDocument());
  });
});
