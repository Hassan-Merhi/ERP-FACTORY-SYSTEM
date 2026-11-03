import { describe, expect, it, vi } from "vitest";
import { isScreenFeedModuleLoadFailure, reportScreenFeedModuleLoadFailure } from "./screen-feed-asset-recovery";

describe("screen-feed stale chunk recovery", () => {
  it("recognizes failed lazy imports in Chromium and Safari", () => {
    expect(
      isScreenFeedModuleLoadFailure(
        new TypeError(
          "Failed to fetch dynamically imported module: https://example.com/assets/screen-feed-capture-engine-ABC123.js"
        )
      )
    ).toBe(true);
    expect(isScreenFeedModuleLoadFailure(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isScreenFeedModuleLoadFailure(new Error("Loading chunk 41 failed"))).toBe(true);
  });

  it("never treats a runtime error or a cancelled request as a chunk failure", () => {
    expect(isScreenFeedModuleLoadFailure(new Error("Canvas context was unavailable"))).toBe(false);
    expect(isScreenFeedModuleLoadFailure(new DOMException("Aborted", "AbortError"))).toBe(false);
    expect(isScreenFeedModuleLoadFailure(null)).toBe(false);
  });

  it("requests recovery only for module loading errors", () => {
    const listener = vi.fn();
    window.addEventListener("erp:screen-feed-module-load-failed", listener);
    try {
      reportScreenFeedModuleLoadFailure(new Error("A regular capture error"));
      expect(listener).not.toHaveBeenCalled();
      reportScreenFeedModuleLoadFailure(
        new TypeError("Failed to fetch dynamically imported module: /assets/screen-feed-capture-engine-ABC123.js")
      );
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("erp:screen-feed-module-load-failed", listener);
    }
  });
});
