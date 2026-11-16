import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMobilePerformanceLifecycle } from "@/hooks/use-mobile-performance-lifecycle";
import {
  getBrowserConnectionProfile,
  getConnectivityPollDelay,
  getQueueRefreshDelay,
  runWhenIdle,
} from "@/lib/mobilePerformance";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function setConnection(connection: { effectiveType?: string; saveData?: boolean } | undefined) {
  Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
}
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  Object.defineProperty(document, "hidden", { configurable: true, value: state === "hidden" });
}

afterEach(() => {
  setConnection(undefined);
  setVisibility("visible");
  vi.useRealTimers();
});

/** Phase 10 contract for phone performance and offline behaviour, checked by calling the code. */
describe("Mobile responsiveness Phase 10 performance and offline behavior", () => {
  it("reads the browser connection profile and treats 2g and data saver as slow", () => {
    setConnection(undefined);
    expect(getBrowserConnectionProfile()).toEqual({ saveData: false, effectiveType: "unknown", slowConnection: false });
    setConnection({ effectiveType: "slow-2g" });
    expect(getBrowserConnectionProfile().slowConnection).toBe(true);
    setConnection({ effectiveType: "2g" });
    expect(getBrowserConnectionProfile().slowConnection).toBe(true);
    setConnection({ effectiveType: "4g", saveData: true });
    expect(getBrowserConnectionProfile().slowConnection).toBe(true);
    setConnection({ effectiveType: "4g" });
    expect(getBrowserConnectionProfile().slowConnection).toBe(false);
  });

  it("stretches connectivity polling when the tab is hidden or the network is slow", () => {
    setConnection({ effectiveType: "4g" });
    expect(getConnectivityPollDelay({ isOnline: true, visible: true })).toBe(60_000);
    expect(getConnectivityPollDelay({ isOnline: true, visible: false })).toBe(5 * 60_000);
    expect(getConnectivityPollDelay({ isOnline: false, visible: false })).toBe(2 * 60_000);
    setConnection({ effectiveType: "2g" });
    expect(getConnectivityPollDelay({ isOnline: true, visible: true })).toBe(2 * 60_000);
    expect(getQueueRefreshDelay(true)).toBe(2 * 60_000);
    expect(getQueueRefreshDelay(false)).toBe(5 * 60_000);
    setConnection({ effectiveType: "4g" });
    expect(getQueueRefreshDelay(true)).toBe(60_000);
  });

  it("runs idle work later and lets it be cancelled", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const cancel = runWhenIdle(callback, 50);
    expect(callback).not.toHaveBeenCalled();
    cancel();
    vi.advanceTimersByTime(5_000);
    expect(callback).not.toHaveBeenCalled();
    runWhenIdle(callback, 50);
    vi.advanceTimersByTime(5_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("connects visibility, online state and the connection profile to the document and TanStack Query", () => {
    setConnection({ effectiveType: "2g", saveData: true });
    const visible = vi.fn();
    const hidden = vi.fn();
    window.addEventListener("erp:app-visible", visible);
    window.addEventListener("erp:app-hidden", hidden);
    const setFocused = vi.spyOn(focusManager, "setFocused");

    const { unmount } = renderHook(() => useMobilePerformanceLifecycle());
    const root = document.documentElement;
    expect(root.dataset.saveData).toBe("true");
    expect(root.dataset.slowConnection).toBe("true");
    expect(root.dataset.effectiveConnection).toBe("2g");
    expect(root.dataset.appVisibility).toBe("visible");

    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(root.dataset.appVisibility).toBe("hidden");
    expect(hidden).toHaveBeenCalled();
    expect(setFocused).toHaveBeenLastCalledWith(false);

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(root.dataset.appVisibility).toBe("visible");
    expect(visible).toHaveBeenCalled();
    expect(setFocused).toHaveBeenLastCalledWith(true);

    unmount();
    window.removeEventListener("erp:app-visible", visible);
    window.removeEventListener("erp:app-hidden", hidden);
    setFocused.mockRestore();
  });

  it("schedules connectivity work adaptively instead of on fixed intervals", () => {
    const connectivity = source("client/src/contexts/ConnectivityContext.tsx");
    expect(connectivity).toContain("getConnectivityPollDelay(");
    expect(connectivity).toContain("getQueueRefreshDelay(");
    expect(connectivity).toContain('window.addEventListener("erp:app-visible"');
    expect(connectivity).not.toContain("setInterval(async () =>");
    expect(connectivity).not.toContain("15_000");
  });

  it("keeps the service worker versioned, preloading navigations and network-only for the API", () => {
    const serviceWorker = source("client/public/sw.js");
    expect(serviceWorker).toMatch(/CACHE_VERSION = "erp-v\d+"/);
    for (const token of [
      "navigationPreload",
      "event.preloadResponse",
      'url.pathname.startsWith("/api/")',
      'cache: "no-store"',
    ]) {
      expect(serviceWorker).toContain(token);
    }
  });

  it("pauses hidden-tab animations and honours data saver in the performance stylesheet", () => {
    const css = source("client/src/styles/mobile-performance.css");
    expect(css).toContain('data-app-visibility="hidden"');
    expect(css).toContain("animation-play-state: paused");
    expect(css).toContain('data-save-data="true"');
    expect(css).toContain('data-slow-connection="true"');
  });
});
