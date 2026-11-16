import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { V5ProformaMobileLines } from "@/pages/factory/V5ProformaMobileLines";

const row = {
  articleCode: "BALE-001",
  productName: "Cotton Mix Bale",
  categoryName: "Cotton",
  stockAvailable: 14,
  totalLoaded: 4,
  freeToPromise: 10,
};

function makeProps() {
  return {
    rows: [row],
    quantities: { [row.articleCode]: "3" },
    prices: { [row.articleCode]: "15.50" },
    kgPrices: { [row.articleCode]: "0.250" },
    pricingModes: { [row.articleCode]: "per_bale" as const },
    onQuantityChange: vi.fn(),
    onPriceChange: vi.fn(),
    onKgPriceChange: vi.fn(),
    onModeChange: vi.fn(),
    weightPerBale: vi.fn().mockReturnValue(40),
    shortageCount: vi.fn().mockReturnValue(0),
    variant: "create" as const,
  };
}

afterEach(cleanup);

describe("iPhone Duo Phase 2 shared proforma mobile editor", () => {
  it("shows product identity, stock, weight and controlled quantity", () => {
    const props = makeProps();
    render(<V5ProformaMobileLines {...props} />);
    expect(screen.getByTestId("v5-create-mobile-lines")).toBeInTheDocument();
    expect(screen.getByText("Cotton Mix Bale")).toBeInTheDocument();
    expect(screen.getByText("120 kg")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("v5-create-mobile-qty-BALE-001"), {
      target: { value: "5" },
    });
    expect(props.onQuantityChange).toHaveBeenCalledWith("BALE-001", "5");
  });

  it("preserves parent-controlled bale versus kilogram pricing", () => {
    const props = makeProps();
    const { rerender } = render(<V5ProformaMobileLines {...props} />);
    fireEvent.change(screen.getByTestId("v5-create-mobile-price-BALE-001"), {
      target: { value: "20" },
    });
    expect(props.onPriceChange).toHaveBeenCalledWith("BALE-001", "20");
    fireEvent.click(screen.getByTestId("v5-create-mobile-mode-per_kg-BALE-001"));
    expect(props.onModeChange).toHaveBeenCalledWith("BALE-001", "per_kg");
    rerender(<V5ProformaMobileLines {...props} pricingModes={{ "BALE-001": "per_kg" }} />);
    fireEvent.change(screen.getByTestId("v5-create-mobile-price-BALE-001"), {
      target: { value: "0.500" },
    });
    expect(props.onKgPriceChange).toHaveBeenCalledWith("BALE-001", "0.500");
  });

  it("uses loading-container multipliers without changing the submitted quantity", () => {
    const props = makeProps();
    render(<V5ProformaMobileLines {...props} multiplier={3} shortageCount={() => 0} />);
    expect(screen.getByText("9 bales")).toBeInTheDocument();
    expect(screen.getByTestId("v5-create-mobile-qty-BALE-001")).toHaveValue(3);
  });

  it("preserves edit removal, shortage notices and amount controls", () => {
    const props = makeProps();
    const onClear = vi.fn();
    render(<V5ProformaMobileLines {...props} variant="edit" existingCodes={new Set(["BALE-001"])}
      onClear={onClear} shortageCount={() => 2} />);
    expect(screen.getByText("Low stock")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("v5-edit-mobile-clear-BALE-001"));
    expect(onClear).toHaveBeenCalledWith("BALE-001");
    fireEvent.change(screen.getByTestId("v5-edit-mobile-qty-BALE-001"), {
      target: { value: "0" },
    });
    expect(props.onQuantityChange).toHaveBeenCalledWith("BALE-001", "0");
  });
});
