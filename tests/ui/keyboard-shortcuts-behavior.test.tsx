/**
 * Global keyboard shortcuts: every Alt+key route, the factory Alt+L / Alt+L I
 * chord (with its 700 ms timeout), the "?" help panel, search focusing, and
 * the rule that plain-key shortcuts never fire while the user is typing.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ location: "/", navigate: vi.fn() }));
vi.mock("wouter", () => ({ useLocation: () => [nav.location, nav.navigate] }));

import { KeyboardShortcuts, KeyboardShortcutsButton } from "@/components/KeyboardShortcuts";

function alt(key: string, code = `Key${key.toUpperCase()}`) {
  fireEvent.keyDown(document, { key, code, altKey: true });
}

beforeEach(() => {
  nav.location = "/";
  nav.navigate = vi.fn();
});

describe("ERP quick navigation", () => {
  it.each([
    ["t", "/tracking"],
    ["d", "/financial-overview"],
    ["a", "/accounts"],
    ["v", "/vouchers"],
    ["i", "/inventory"],
    ["s", "/settings"],
    ["p", "/parties"],
    ["c", "/containers-otw"],
  ])("Alt+%s opens %s", (key, route) => {
    render(<KeyboardShortcuts />);
    alt(key);
    expect(nav.navigate).toHaveBeenCalledWith(route);
  });

  it.each([
    ["1", "/"],
    ["2", "/factory/stock-entry"],
    ["3", "/properties/rentals"],
  ])("Alt+%s switches mode to %s", (digit, route) => {
    render(<KeyboardShortcuts />);
    alt(digit, `Digit${digit}`);
    expect(nav.navigate).toHaveBeenCalledWith(route);
  });

  it("ignores Ctrl+Alt and Cmd+Alt combinations and unmapped keys", () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: "t", code: "KeyT", altKey: true, ctrlKey: true });
    fireEvent.keyDown(document, { key: "t", code: "KeyT", altKey: true, metaKey: true });
    alt("z");
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe("factory quick navigation", () => {
  beforeEach(() => {
    nav.location = "/factory/daybook";
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["o", "/factory/intelligence/dashboard"],
    ["d", "/factory/daybook"],
    ["a", "/factory/accounts"],
    ["s", "/factory/stock-allocation"],
    ["r", "/factory/raw-materials"],
    ["b", "/factory/bales-hub"],
    ["i", "/factory/invoicing"],
    ["c", "/factory/containers-hub"],
    ["p", "/factory/parties"],
    ["v", "/factory/vouchers"],
  ])("Alt+%s opens %s", (key, route) => {
    render(<KeyboardShortcuts />);
    alt(key);
    expect(nav.navigate).toHaveBeenCalledWith(route);
  });

  it("Alt+L then I opens location inventory and cancels the loadings fallback", () => {
    render(<KeyboardShortcuts />);
    alt("l");
    alt("i");
    act(() => vi.advanceTimersByTime(1000));
    expect(nav.navigate.mock.calls).toEqual([["/factory/location-inventory"]]);
  });

  it("Alt+L alone falls back to loadings after the chord window", () => {
    render(<KeyboardShortcuts />);
    alt("l");
    expect(nav.navigate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(700));
    expect(nav.navigate).toHaveBeenCalledWith("/factory/sales/loadings");
  });

  it("a different key after Alt+L abandons the chord and runs that key", () => {
    render(<KeyboardShortcuts />);
    alt("l");
    alt("d");
    act(() => vi.advanceTimersByTime(1000));
    expect(nav.navigate.mock.calls).toEqual([["/factory/daybook"]]);
  });

  it("clears a pending chord on unmount", () => {
    const { unmount } = render(<KeyboardShortcuts />);
    alt("l");
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe("help panel and search", () => {
  it("toggles the panel with ?, closes with Escape, and lists the ERP group", () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: "?" });
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
    expect(screen.getByText("ERP Quick Nav")).toBeInTheDocument();
    expect(screen.getByText("Mode Switching")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });

  it("shows the factory group on factory routes, with chords rendered as 'then'", () => {
    nav.location = "/factory/accounts";
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: "?" });
    expect(screen.getByText("Factory Quick Nav")).toBeInTheDocument();
    expect(screen.getByText("Location Inventory")).toBeInTheDocument();
    expect(screen.getAllByText("then").length).toBeGreaterThan(0);
  });

  it("opens from the toolbar button", () => {
    render(
      <>
        <KeyboardShortcuts />
        <KeyboardShortcutsButton />
      </>
    );
    fireEvent.click(screen.getByTestId("button-keyboard-shortcuts"));
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
  });

  it("focuses the page search on / and Ctrl+K", () => {
    render(
      <>
        <KeyboardShortcuts />
        <input data-testid="input-search-items" />
      </>
    );
    const search = screen.getByTestId("input-search-items");

    fireEvent.keyDown(document, { key: "/" });
    expect(document.activeElement).toBe(search);

    search.blur();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(search);
  });

  it("does not steal ? or / while the user is typing", () => {
    render(
      <>
        <KeyboardShortcuts />
        <textarea data-testid="notes" />
      </>
    );
    const notes = screen.getByTestId("notes");
    fireEvent.keyDown(notes, { key: "?" });
    fireEvent.keyDown(notes, { key: "/" });
    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });
});
