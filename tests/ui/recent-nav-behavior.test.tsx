/**
 * useRecentNav drives the sidebar's "Recent" list: the last five pages the
 * user opened, per company, limited to pages they may still see. These cases
 * cover what gets recorded, what gets dropped and where it is persisted.
 */
import { renderHook } from "@testing-library/react";
import { canonicalNavigationPath, useRecentNav } from "@/hooks/use-recent-nav";
import { pageState, resetPageState } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);

const NAV = [
  { url: "/", title: "Dashboard" },
  { url: "/vouchers", title: "Vouchers" },
  { url: "/stock", title: "Stock" },
  { url: "/customers", title: "Customers" },
  { url: "/suppliers", title: "Suppliers" },
  { url: "/reports", title: "Reports" },
  { url: "/settings", title: "Settings" },
];

let now = 1_000;

function stored(companyId?: number) {
  const raw = localStorage.getItem(companyId ? `recent-nav-v1-company-${companyId}` : "recent-nav-v1-global");
  return raw ? JSON.parse(raw) : null;
}

function visit(rerender: () => void, location: string) {
  now += 1;
  pageState.location = location;
  rerender();
}

beforeEach(() => {
  resetPageState();
  localStorage.clear();
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => vi.restoreAllMocks());

describe("useRecentNav", () => {
  it("records visited pages newest first, keeps five and moves a revisit to the top", () => {
    pageState.location = "/vouchers";
    const { result, rerender } = renderHook(() => useRecentNav(NAV, 1));

    for (const location of ["/stock", "/customers", "/suppliers", "/reports", "/settings", "/stock"]) {
      visit(rerender, location);
    }

    expect(result.current.map((entry) => entry.title)).toEqual([
      "Stock",
      "Settings",
      "Reports",
      "Suppliers",
      "Customers",
    ]);
    expect(stored(1).map((entry: { url: string }) => entry.url)).toEqual(result.current.map((entry) => entry.url));
  });

  it("records the nav item's canonical url and title, ignoring query and hash", () => {
    pageState.location = "/stock?group=3#row-9";
    const { result } = renderHook(() => useRecentNav(NAV, 1));

    expect(result.current).toEqual([{ url: "/stock", title: "Stock", visitedAt: now }]);
  });

  it("does not record pages outside the nav or that the user may not see", () => {
    pageState.location = "/vouchers/123/print";
    const { result, rerender } = renderHook(() => useRecentNav(NAV, 1, (item) => item.url !== "/settings"));
    visit(rerender, "/settings");

    expect(result.current).toEqual([]);
  });

  it("keeps a separate list per company and a global list without one", () => {
    pageState.location = "/stock";
    renderHook(() => useRecentNav(NAV, 1));
    pageState.location = "/customers";
    renderHook(() => useRecentNav(NAV, 2));
    pageState.location = "/reports";
    renderHook(() => useRecentNav(NAV));

    expect(stored(1).map((entry: { url: string }) => entry.url)).toEqual(["/stock"]);
    expect(stored(2).map((entry: { url: string }) => entry.url)).toEqual(["/customers"]);
    expect(stored().map((entry: { url: string }) => entry.url)).toEqual(["/reports"]);
  });

  it("drops stored pages the user has lost access to and rewrites storage", () => {
    localStorage.setItem(
      "recent-nav-v1-company-1",
      JSON.stringify([
        { url: "/settings", title: "Settings", visitedAt: 5 },
        { url: "/stock?old=1", title: "Old stock title", visitedAt: 4 },
        { url: "/retired-page", title: "Retired", visitedAt: 3 },
        { url: "/stock", title: "Stock", visitedAt: 2 },
      ])
    );
    pageState.location = "/nowhere";

    const { result } = renderHook(() => useRecentNav(NAV, 1, (item) => item.url !== "/settings"));

    expect(result.current).toEqual([{ url: "/stock", title: "Stock", visitedAt: 4 }]);
    expect(stored(1)).toEqual(result.current);
  });

  it("re-filters the list when a permission is revoked while mounted", () => {
    pageState.location = "/settings";
    let canSeeSettings = true;
    const { result, rerender } = renderHook(() =>
      useRecentNav(NAV, 1, (item) => item.url !== "/settings" || canSeeSettings)
    );
    visit(rerender, "/stock");
    expect(result.current.map((entry) => entry.url)).toEqual(["/stock", "/settings"]);

    canSeeSettings = false;
    rerender();

    expect(result.current.map((entry) => entry.url)).toEqual(["/stock"]);
  });

  it("does not loop when the visibility callback is recreated on every render", () => {
    pageState.location = "/stock";
    let renders = 0;
    const { rerender } = renderHook(() => {
      renders += 1;
      return useRecentNav(NAV, 1, (item) => item.url !== "/settings");
    });
    rerender();
    rerender();

    expect(renders).toBeLessThan(10);
  });

  it("starts empty from unreadable storage and keeps working when storage rejects writes", () => {
    localStorage.setItem("recent-nav-v1-company-1", "{not json");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    pageState.location = "/stock";

    const { result } = renderHook(() => useRecentNav(NAV, 1));

    expect(result.current.map((entry) => entry.url)).toEqual(["/stock"]);
  });
});

describe("canonicalNavigationPath", () => {
  it.each([
    ["/stock?group=3", "/stock"],
    ["/stock#top", "/stock"],
    ["/stock#top?x=1", "/stock"],
    ["/stock?x=1#top", "/stock"],
    ["?only=query", "/"],
    ["/plain", "/plain"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalNavigationPath(input)).toBe(expected);
  });
});
