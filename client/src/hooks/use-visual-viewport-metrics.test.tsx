import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVisualViewportMetrics } from "./use-visual-viewport-metrics";

/**
 * Phone dialogs (mobile-shell-dialogs.css, ERP and Factory) are lifted above the on-screen
 * keyboard and capped to the visible height through these CSS variables. Headless browsers cannot
 * open a real keyboard, so the keyboard is simulated here by shrinking the visual viewport.
 */

class FakeVisualViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
}

let viewport: FakeVisualViewport;
const root = document.documentElement;

beforeEach(() => {
  viewport = new FakeVisualViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "visualViewport");
});

function openKeyboard(height: number) {
  viewport.height = height;
  viewport.dispatchEvent(new Event("resize"));
}

describe("useVisualViewportMetrics", () => {
  it("publishes the visible height and a zero keyboard inset while no keyboard is open", () => {
    renderHook(() => useVisualViewportMetrics());
    expect(root.style.getPropertyValue("--erp-visual-viewport-height")).toBe("800px");
    expect(root.style.getPropertyValue("--erp-keyboard-inset")).toBe("0px");
  });

  it("lifts dialogs by the keyboard height and keeps the focused dialog field in view", async () => {
    document.body.innerHTML = '<div data-slot="dialog-content"><input id="amount" /></div>';
    const field = document.getElementById("amount") as HTMLInputElement;
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    field.focus();

    renderHook(() => useVisualViewportMetrics());
    openKeyboard(460);

    await waitFor(() => expect(root.style.getPropertyValue("--erp-keyboard-inset")).toBe("340px"));
    expect(root.style.getPropertyValue("--erp-visual-viewport-height")).toBe("460px");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });

  it("does not scroll fields outside dialogs and sheets", async () => {
    document.body.innerHTML = '<main><input id="search" /></main>';
    const field = document.getElementById("search") as HTMLInputElement;
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    field.focus();

    renderHook(() => useVisualViewportMetrics());
    openKeyboard(460);

    await waitFor(() => expect(root.style.getPropertyValue("--erp-keyboard-inset")).toBe("340px"));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("removes the variables when the shell unmounts", () => {
    const { unmount } = renderHook(() => useVisualViewportMetrics());
    unmount();
    expect(root.style.getPropertyValue("--erp-visual-viewport-height")).toBe("");
    expect(root.style.getPropertyValue("--erp-keyboard-inset")).toBe("");
  });
});
