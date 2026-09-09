import { beforeEach, describe, expect, it } from "vitest";

import {
  forcedRefreshRequestInit,
  forcedRefreshRequestInput,
  isManualRefreshControl,
  isManualRefreshWindowActive,
  markManualRefresh,
} from "./forcedApiRefresh";

describe("forced API refresh", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("recognizes existing refresh test ids including nested icon clicks", () => {
    const button = document.createElement("button");
    button.dataset.testid = "button-refresh-journal";
    const icon = document.createElement("span");
    button.append(icon);
    document.body.append(button);

    expect(isManualRefreshControl(icon)).toBe(true);
  });

  it("does not classify unrelated buttons as forced refresh controls", () => {
    const button = document.createElement("button");
    button.dataset.testid = "button-save";
    document.body.append(button);

    expect(isManualRefreshControl(button)).toBe(false);
  });

  it("supports an explicit data attribute for refresh controls without a standard test id", () => {
    const button = document.createElement("button");
    button.dataset.forceApiRefresh = "true";
    document.body.append(button);

    expect(isManualRefreshControl(button)).toBe(true);
  });

  it("keeps the manual refresh window short and bounded", () => {
    markManualRefresh(10_000);
    expect(isManualRefreshWindowActive(10_499)).toBe(true);
    expect(isManualRefreshWindowActive(10_501)).toBe(false);
  });

  it("adds the server refresh marker while preserving the original query string", () => {
    const forced = String(forcedRefreshRequestInput("/api/factory/bale-ledger?section=currentStock"));
    const url = new URL(forced, window.location.origin);

    expect(url.pathname).toBe("/api/factory/bale-ledger");
    expect(url.searchParams.get("section")).toBe("currentStock");
    expect(url.searchParams.get("__refresh")).toBe("1");
  });

  it("uses browser reload semantics without adding a CORS-triggering custom header", () => {
    const init = forcedRefreshRequestInit("/api/factory/bale-ledger", {
      credentials: "include",
      headers: { "x-company-id": "7" },
    });
    const headers = new Headers(init.headers);

    expect(init.cache).toBe("reload");
    expect(init.credentials).toBe("include");
    expect(headers.get("x-company-id")).toBe("7");
    expect(headers.has("x-bypass-request-storm-guard")).toBe(false);
  });
});
