import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ toast }));

import { printDocument } from "./printDocument";

function fakeWindow(readyState: DocumentReadyState = "loading") {
  const listeners: Record<string, () => void> = {};
  const win = {
    document: { write: vi.fn(), close: vi.fn(), readyState },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      listeners[type] = listener;
    }),
  };
  return { win, fireLoad: () => listeners.load?.() };
}

describe("printDocument", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toast.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes the HTML unchanged and prints once the window has loaded", () => {
    const { win, fireLoad } = fakeWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(win as never);

    const result = printDocument("<html><body>Report</body></html>", { features: "width=900,height=700" });

    expect(result).toBe(win);
    expect(open).toHaveBeenCalledWith("", "_blank", "width=900,height=700");
    expect(win.document.write).toHaveBeenCalledWith("<html><body>Report</body></html>");
    expect(win.document.close).toHaveBeenCalledOnce();
    expect(win.print).not.toHaveBeenCalled();

    fireLoad();
    expect(win.print).toHaveBeenCalledOnce();
    // The fallback timer does not print a second time.
    vi.advanceTimersByTime(5000);
    expect(win.print).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });

  it("prints after the fallback delay when no load event arrives", () => {
    const { win } = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win as never);

    printDocument("<p>Statement</p>", { fallbackMs: 600 });
    vi.advanceTimersByTime(599);
    expect(win.print).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.print).toHaveBeenCalledOnce();
  });

  it("prints straight away when the written document is already complete", () => {
    const { win } = fakeWindow("complete");
    vi.spyOn(window, "open").mockReturnValue(win as never);

    printDocument("<p>Done</p>");
    vi.advanceTimersByTime(0);
    expect(win.print).toHaveBeenCalledOnce();
  });

  it("closes a one-off document once the print dialog returns", () => {
    const { win, fireLoad } = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win as never);

    printDocument("<p>Waste Disposal Record</p>", { closeAfterPrint: true });
    expect(win.close).not.toHaveBeenCalled();
    fireLoad();
    expect(win.print).toHaveBeenCalledOnce();
    expect(win.close).toHaveBeenCalledOnce();
  });

  it("only opens the window when the HTML prints itself", () => {
    const { win, fireLoad } = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win as never);

    printDocument("<script>window.onload=()=>window.print();</script>", { print: false });
    fireLoad();
    vi.advanceTimersByTime(5000);
    expect(win.document.write).toHaveBeenCalledOnce();
    expect(win.print).not.toHaveBeenCalled();
    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  it("shows the Pop-up blocked toast when the browser blocks the window", () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    expect(printDocument("<p>Report</p>")).toBeNull();
    expect(toast).toHaveBeenCalledWith({
      title: "Pop-up blocked",
      description: "Allow pop-ups for this site and try again.",
      variant: "destructive",
    });
  });

  it("lets a screen replace the blocked toast with its own", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const onBlocked = vi.fn();

    expect(printDocument("<p>Report</p>", { onBlocked })).toBeNull();
    expect(onBlocked).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });
});
