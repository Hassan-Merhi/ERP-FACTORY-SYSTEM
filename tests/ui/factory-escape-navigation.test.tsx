import { renderHook } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { ReactNode } from "react";
import { useAppNavigation } from "@/app/useAppNavigation";
import { isFactoryTopLevelPath } from "@/lib/parent-routes";

/**
 * Factory navigation contract (docs/factory-navigation-registry.md): Escape/Back on a top-level
 * Factory page performs no navigation; child pages go to their registered parent. The fallback
 * used to call history.back() on top-level pages, returning to whatever came before (even ERP).
 */

describe("isFactoryTopLevelPath", () => {
  it("recognises registry destinations and their hub sections", () => {
    expect(isFactoryTopLevelPath("/factory/daybook")).toBe(true);
    expect(isFactoryTopLevelPath("/factory/invoicing?tab=proformas")).toBe(true);
    expect(isFactoryTopLevelPath("/factory/intelligence/production-hub?section=waste")).toBe(true);
  });

  it("does not treat detail pages or other modes as top level", () => {
    expect(isFactoryTopLevelPath("/factory/customers/12")).toBe(false);
    expect(isFactoryTopLevelPath("/factory/voucher-detail/5")).toBe(false);
    expect(isFactoryTopLevelPath("/daybook")).toBe(false);
  });
});

describe("Escape/Back fallback in Factory", () => {
  let back: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    window.history.pushState({}, "", "/");
    window.history.pushState({}, "", "/");
  });

  afterEach(() => back.mockRestore());

  function navigationAt(path: string) {
    window.history.replaceState({}, "", path);
    const location = memoryLocation({ path, record: true });
    const wrapper = ({ children }: { children: ReactNode }) => <Router hook={location.hook}>{children}</Router>;
    const { result } = renderHook(() => useAppNavigation(), { wrapper });
    return { result, location };
  }

  it("stays on a top-level Factory page", () => {
    const { result, location } = navigationAt("/factory/daybook");
    result.current.handleGoBack();
    expect(back).not.toHaveBeenCalled();
    expect(location.history).toEqual(["/factory/daybook"]);
  });

  it("goes to the registered parent from a Factory detail page", () => {
    const { result, location } = navigationAt("/factory/customers/12");
    result.current.handleGoBack();
    expect(location.history.at(-1)).toBe("/factory/parties?section=customers");
    expect(back).not.toHaveBeenCalled();
  });
});
