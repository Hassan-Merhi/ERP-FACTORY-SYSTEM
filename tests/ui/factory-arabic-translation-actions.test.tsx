import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FactoryArabicTranslationActions } from "@/components/FactoryArabicTranslationActions";

function renderActions(input: { canImport: boolean; canExport: boolean }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["/api/factory/bale-products/arabic-import/capabilities/import"], input.canImport);
  client.setQueryData(["/api/factory/bale-products/arabic-import/capabilities/export"], input.canExport);
  return render(
    <QueryClientProvider client={client}>
      <FactoryArabicTranslationActions />
    </QueryClientProvider>
  );
}

describe("Factory Arabic translation actions", () => {
  it("shows import and export actions when both operational permissions are allowed", () => {
    renderActions({ canImport: true, canExport: true });
    expect(screen.getByTestId("button-export-arabic-template")).toHaveTextContent(
      "Export Excel (Arabic Names Template)"
    );
    expect(screen.getByTestId("button-import-arabic-names")).toHaveTextContent("Import Arabic Names");
  });

  it("opens the preview-first workflow for any role granted import permission", () => {
    renderActions({ canImport: true, canExport: false });
    expect(screen.queryByTestId("button-export-arabic-template")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-import-arabic-names"));

    expect(screen.getByText("Import Arabic product and category names")).toBeInTheDocument();
    expect(screen.getByTestId("input-arabic-translation-workbook").getAttribute("accept")).toContain(".xlsx");
    expect(screen.getByTestId("select-arabic-import-mode")).toHaveTextContent("Fill missing Arabic names only");
    expect(screen.getByTestId("button-preview-arabic-import")).toBeDisabled();
    expect(screen.getByTestId("button-apply-arabic-import")).toBeDisabled();
  });

  it("does not expose controls when both operational permissions are denied", () => {
    const { container } = renderActions({ canImport: false, canExport: false });
    expect(container).toBeEmptyDOMElement();
  });
});
