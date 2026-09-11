import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBoundedTableRows } from "../../client/src/hooks/useBoundedTableRows";

function Harness({ count = 500 }: { count?: number }) {
  const windowed = useBoundedTableRows({
    rowCount: count,
    rowHeight: 40,
    minimumRows: 100,
    overscan: 10,
  });
  const rows = Array.from(
    { length: windowed.endIndex - windowed.startIndex },
    (_, offset) => windowed.startIndex + offset
  );

  return (
    <div ref={windowed.scrollRef} data-testid="scroller" style={{ height: 400, overflowY: "auto" }}>
      <div data-testid="top-spacer" style={{ height: windowed.topSpacerHeight }} />
      {rows.map((row) => (
        <div key={row} data-testid={`row-${row}`} style={{ height: 40 }}>
          {row}
        </div>
      ))}
      <div data-testid="bottom-spacer" style={{ height: windowed.bottomSpacerHeight }} />
    </div>
  );
}

describe("useBoundedTableRows", () => {
  it("keeps the initial DOM bounded while preserving the full scroll height", async () => {
    render(<Harness />);

    await waitFor(() => expect(screen.queryByTestId("row-150")).toBeNull());
    expect(screen.getByTestId("row-0")).toBeTruthy();
    expect(Number.parseFloat(screen.getByTestId("bottom-spacer").style.height)).toBeGreaterThan(0);
    expect(screen.queryAllByTestId(/^row-/)).toHaveLength(110);
  });

  it("moves the mounted window as the user scrolls instead of accumulating rows", async () => {
    render(<Harness />);
    const scroller = screen.getByTestId("scroller");

    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 10_000, writable: true });
    fireEvent.scroll(scroller);

    await waitFor(() => expect(screen.getByTestId("row-250")).toBeTruthy());
    expect(screen.queryByTestId("row-0")).toBeNull();
    expect(screen.queryAllByTestId(/^row-/).length).toBeLessThanOrEqual(120);
    expect(Number.parseFloat(screen.getByTestId("top-spacer").style.height)).toBeGreaterThan(0);
  });

  it("clamps a stale deep scroll position when filters shrink the result set", async () => {
    const { rerender } = render(<Harness count={500} />);
    const scroller = screen.getByTestId("scroller");
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 16_000, writable: true });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByTestId("row-400")).toBeTruthy());

    rerender(<Harness count={200} />);

    await waitFor(() => expect(screen.getByTestId("row-199")).toBeTruthy());
    expect(screen.queryByTestId("row-400")).toBeNull();
    expect(screen.queryAllByTestId(/^row-/).length).toBeLessThanOrEqual(100);
  });

  it("expands the logical list for browser printing and restores virtualization afterward", async () => {
    render(<Harness count={180} />);

    expect(screen.queryByTestId("row-179")).toBeNull();
    act(() => window.dispatchEvent(new Event("beforeprint")));
    await waitFor(() => expect(screen.getByTestId("row-179")).toBeTruthy());
    expect(screen.getByTestId("bottom-spacer").style.height).toBe("0px");

    act(() => window.dispatchEvent(new Event("afterprint")));
    await waitFor(() => expect(screen.queryByTestId("row-179")).toBeNull());
  });
});
