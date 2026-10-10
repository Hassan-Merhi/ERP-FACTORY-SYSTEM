import { afterEach, describe, expect, it, vi } from "vitest";
import { readInitialSidebarOpen } from "./sidebar";

function mockViewport(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches, media: query }) as MediaQueryList);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "sidebar_state=; path=/; max-age=0";
});

describe("readInitialSidebarOpen", () => {
  it("pins the sidebar from lg and collapses it below", () => {
    mockViewport(true);
    expect(readInitialSidebarOpen()).toBe(true);
    mockViewport(false);
    expect(readInitialSidebarOpen()).toBe(false);
  });

  it("lets the saved sidebar_state cookie win over the viewport default", () => {
    mockViewport(true);
    document.cookie = "sidebar_state=false; path=/";
    expect(readInitialSidebarOpen()).toBe(false);
    document.cookie = "sidebar_state=true; path=/";
    mockViewport(false);
    expect(readInitialSidebarOpen()).toBe(true);
  });
});
