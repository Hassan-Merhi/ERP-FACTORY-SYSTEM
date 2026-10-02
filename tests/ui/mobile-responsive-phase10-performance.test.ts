import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile responsiveness Phase 10 performance and offline behavior", () => {
  it("provides connection and visibility-aware scheduling helpers", () => {
    const performance = source("client/src/lib/mobilePerformance.ts");

    for (const token of [
      "getBrowserConnectionProfile",
      "getConnectivityPollDelay",
      "getQueueRefreshDelay",
      "isDocumentVisible",
      "runWhenIdle",
      'effectiveType === "slow-2g"',
      'effectiveType === "2g"',
      "5 * 60_000",
      "2 * 60_000",
      "60_000",
    ]) {
      expect(performance).toContain(token);
    }
  });

  it("connects browser lifecycle signals to TanStack Query", () => {
    const lifecycle = source("client/src/hooks/use-mobile-performance-lifecycle.ts");
    const app = source("client/src/app/AuthenticatedApp.tsx");

    for (const token of [
      "focusManager",
      "onlineManager",
      "visibilitychange",
      "erp:app-visible",
      "erp:app-hidden",
      "root.dataset.saveData",
      "root.dataset.slowConnection",
      "mobile-performance.css",
    ]) {
      expect(lifecycle).toContain(token);
    }

    expect(app).toContain("useMobilePerformanceLifecycle");
    expect(app).toContain("useMobilePerformanceLifecycle();");
  });

  it("replaces fixed connectivity intervals with adaptive scheduling", () => {
    const connectivity = source("client/src/contexts/ConnectivityContext.tsx");

    for (const token of [
      "getConnectivityPollDelay",
      "getQueueRefreshDelay",
      "isDocumentVisible",
      "runWhenIdle",
      "schedulePoll",
      "scheduleCounts",
      'window.addEventListener("erp:app-visible"',
      // cancelRefetch: false keeps a sync-triggered invalidation from aborting
      // the requests already on their way.
      'queryClient.invalidateQueries({ refetchType: "active" }, { cancelRefetch: false })',
    ]) {
      expect(connectivity).toContain(token);
    }

    expect(connectivity).not.toContain("setInterval(async () =>");
    expect(connectivity).not.toContain("15_000");
  });

  it("uses navigation preload while preserving network-only API behavior", () => {
    const serviceWorker = source("client/public/sw.js");

    // Bumped with every service-worker change; the contract is that it is versioned.
    expect(serviceWorker).toMatch(/CACHE_VERSION = "erp-v\d+"/);
    for (const token of [
      "navigationPreload",
      "event.preloadResponse",
      "networkOnlyApi(request)",
      'url.pathname.startsWith("/api/")',
      'cache: "no-store"',
      "deleteErpCachesExcept(CACHE_VERSION)",
    ]) {
      expect(serviceWorker).toContain(token);
    }
  });

  it("pauses hidden-tab animations and honors data saver", () => {
    const css = source("client/src/styles/mobile-performance.css");

    expect(css).toContain('data-app-visibility="hidden"');
    expect(css).toContain("animation-play-state: paused");
    expect(css).toContain('data-save-data="true"');
    expect(css).toContain('data-slow-connection="true"');
  });
});
