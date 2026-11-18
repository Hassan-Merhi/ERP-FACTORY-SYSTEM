import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { POSDaybookTransferDetails } from "@/pages/pos/POSDaybookTransferDetails";
import type { PosDaybookTransferData } from "@/pages/pos/posdaybook/types";

const transfer: PosDaybookTransferData = {
  id: 17,
  voucherId: 99,
  sourceLocationId: 1,
  sourceLocationName: "Sending Store",
  destinationLocationId: 2,
  destinationLocationName: "Receiving Store",
  inventoryApplied: true,
  notes: "Goods moved to branch",
  items: [
    {
      id: 23,
      stockItemId: 7,
      stockItemCode: "SH-7",
      stockItemName: "Shirts",
      stockItemUom: "PCS",
      sourceLocationId: 1,
      sourceLocationName: "Sending Store",
      quantity: "12.000",
    },
  ],
};

describe("POS Daybook transfer details", () => {
  it("renders source, destination, status and quantities with no financial controls", () => {
    render(<POSDaybookTransferDetails transfer={transfer} />);
    expect(screen.getByTestId("pos-transfer-source")).toHaveTextContent("Sending Store");
    expect(screen.getByTestId("pos-transfer-destination")).toHaveTextContent("Receiving Store");
    expect(screen.getByText("Stock applied")).toBeInTheDocument();
    expect(screen.getByText("Shirts")).toBeInTheDocument();
    expect(screen.getByText("12.000 PCS")).toBeInTheDocument();
    expect(screen.getByText("Goods moved to branch")).toBeInTheDocument();
    expect(screen.queryByText(/total amount|unit price|profit|cost|edit transaction/i)).not.toBeInTheDocument();
  });

  it("handles missing transfer data and empty item lists", () => {
    const missing = render(<POSDaybookTransferDetails transfer={undefined} />);
    expect(screen.getByText("Transfer details are unavailable.")).toBeInTheDocument();
    missing.unmount();
    render(<POSDaybookTransferDetails transfer={{ ...transfer, items: [], inventoryApplied: false, notes: null }} />);
    expect(screen.getByText("Pending stock application")).toBeInTheDocument();
    expect(screen.getByText("No transfer items for this location.")).toBeInTheDocument();
  });
});
