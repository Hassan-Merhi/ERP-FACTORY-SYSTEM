import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile responsiveness Phase 8 POS", () => {
  it("hardens the POS shell for phone and tablet workspaces", () => {
    const shell = source("client/src/app/PosShell.tsx");

    for (const token of [
      'data-pos-shell="true"',
      'data-pos-workspace="true"',
      "max-sm:[&_button]:min-h-11",
      "max-sm:[&_input]:text-base",
      "pt-[max(0.5rem,env(safe-area-inset-top))]",
      "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
      "h-11 w-11 sm:h-9 sm:w-9",
    ]) {
      expect(shell).toContain(token);
    }
  });

  it("uses one desktop header and one mobile checkout path", () => {
    const header = source("client/src/pages/pos/pos-components/POSHeader.tsx");
    const mobile = source("client/src/pages/pos/pos-components/PosMobileLayout.tsx");

    expect(header).toContain('data-pos-desktop-header="true"');
    expect(header).toContain('className="hidden px-4 pt-4 lg:block"');
    expect(mobile).toContain('data-pos-mobile-page="true"');
    expect(mobile).toContain('data-pos-mobile-checkout="true"');
    expect(mobile).toContain("sticky bottom-0 z-40 mt-auto");
    expect(mobile).toContain("env(safe-area-inset-bottom)");
    expect(mobile).toContain('data-testid="button-mobile-checkout"');
  });

  it("makes mobile product search accessible and touch sized", () => {
    const mobile = source("client/src/pages/pos/pos-components/PosMobileLayout.tsx");

    for (const token of [
      'role="combobox"',
      'aria-autocomplete="list"',
      "aria-controls={resultsId}",
      'role="listbox"',
      'aria-label="Matching stock items"',
      "max-h-[min(22rem,48dvh)]",
      "min-h-14 w-full",
      "slice(0, 60)",
    ]) {
      expect(mobile).toContain(token);
    }
  });

  it("provides mobile cart editing without changing POS save behavior", () => {
    const mobile = source("client/src/pages/pos/pos-components/PosMobileLayout.tsx");

    for (const token of [
      "data-testid={`input-mobile-qty-${actualIndex}`}",
      "data-testid={`input-mobile-rate-${actualIndex}`}",
      "Decrease quantity for",
      "Increase quantity for",
      'updateRow(actualIndex, "quantity"',
      'updateRow(actualIndex, "rate"',
      "onClick={handleSaveSale}",
      "disabled={saveMutation?.isPending || !hasValidItems || disableSave}",
    ]) {
      expect(mobile).toContain(token);
    }

    expect(mobile).not.toContain("apiRequest(");
    expect(mobile).not.toContain("useMutation(");
  });

  it("converts POS transfer-order filters and actions for phones", () => {
    const transfers = source("client/src/pages/pos/PosTransferOrders.tsx");

    for (const token of [
      'data-pos-transfer-orders="true"',
      'role="search"',
      'aria-label="Transfer order filters"',
      "grid-cols-1 gap-3",
      "sm:grid-cols-2",
      "min-h-11 w-full",
      "grid grid-cols-2 gap-2",
      "data-testid={`button-view-${transfer.voucherId}`}",
      "data-testid={`button-edit-${transfer.voucherId}`}",
    ]) {
      expect(transfers).toContain(token);
    }

    expect(transfers).toContain("fetch(`/api/stock-transfers/list?${params}`");
    expect(transfers).toContain("setEditVoucherId(transfer.voucherId)");
  });

  it("keeps Phase 8 sources free from POS accounting and inventory mutations", () => {
    const sources = [
      source("client/src/app/PosShell.tsx"),
      source("client/src/pages/pos/pos-components/POSHeader.tsx"),
      source("client/src/pages/pos/pos-components/PosMobileLayout.tsx"),
      source("client/src/pages/pos/PosTransferOrders.tsx"),
    ];

    for (const contents of sources) {
      for (const forbidden of [
        "adjustInventory",
        "costPrice =",
        "ledgerAccountId:",
        'POST", "/api',
        'PUT", "/api',
        'DELETE", "/api',
      ]) {
        expect(contents).not.toContain(forbidden);
      }
    }
  });
});
