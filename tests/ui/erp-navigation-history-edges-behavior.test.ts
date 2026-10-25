/**
 * Edge cases of the ERP navigation history tracker beyond its unit tests:
 * nested installs share one tracker, foreign or damaged history state is
 * never trusted, a push without a URL stays on the current entry, and the
 * legacy Back-button upgrade ignores modified clicks, non-back controls and
 * pages with no tracked previous entry.
 */
import {
  canGoBackToPreviousErpLocation,
  goBackToPreviousErpLocation,
  installErpNavigationHistory,
} from "@/lib/erp-navigation-history";

const KEY = "__erpNavigation";
const cleanups: Array<() => void> = [];
const install = () => {
  const cleanup = installErpNavigationHistory();
  cleanups.push(cleanup);
  return cleanup;
};

beforeEach(() => {
  window.history.replaceState({}, "", "/stock");
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function backButton(testId = "button-back") {
  const button = document.createElement("button");
  button.dataset.testid = testId;
  const icon = document.createElement("span");
  button.append(icon);
  document.body.append(button);
  return { button, icon };
}

describe("ERP navigation history edges", () => {
  it("keeps one tracker across nested installs until the last one leaves", () => {
    const outer = install();
    const tracked = window.history.pushState;
    const inner = install();

    expect(window.history.pushState).toBe(tracked);
    inner();
    expect(window.history.pushState).toBe(tracked);
    outer();
    expect(window.history.pushState).not.toBe(tracked);
    cleanups.length = 0;
  });

  it("does nothing to history before it is installed", () => {
    window.history.replaceState({ a: 1 }, "", "/stock");

    expect(goBackToPreviousErpLocation()).toBe(false);
    expect(window.history.state).toEqual({ a: 1 });
  });

  it("stays on the current entry for a push without a URL", () => {
    install();

    window.history.pushState({ step: 2 }, "");

    expect(window.history.state[KEY]).toMatchObject({ from: "/stock", entryUrl: "/stock" });
  });

  it.each([
    ["not an object", "x"],
    ["another version", { version: 2, mode: "erp", from: "/a", entryUrl: "/stock", scrollTop: 0 }],
    ["no entry URL", { version: 1, mode: "erp", from: "/a", scrollTop: 0 }],
    ["a non-string origin", { version: 1, mode: "erp", from: 3, entryUrl: "/stock", scrollTop: 0 }],
    ["a bad scroll position", { version: 1, mode: "erp", from: "/a", entryUrl: "/stock", scrollTop: Infinity }],
  ])("ignores history state with %s", (_label, meta) => {
    install();
    vi.spyOn(window.history, "length", "get").mockReturnValue(3);
    window.history.replaceState({ [KEY]: meta }, "", "/stock");
    // The tracker rewrites the meta on replace: put the damaged one back underneath it.
    Object.defineProperty(window.history, "state", { configurable: true, get: () => ({ [KEY]: meta }) });

    expect(canGoBackToPreviousErpLocation()).toBe(false);
    delete (window.history as { state?: unknown }).state;
  });

  it("upgrades a legacy Back button only for a plain primary click with a tracked previous page", () => {
    install();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    vi.spyOn(window.history, "length", "get").mockReturnValue(3);
    const { icon } = backButton("button-back-to-list");
    const other = backButton("button-save");

    icon.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(back).not.toHaveBeenCalled();

    window.history.pushState({}, "", "/stock/7");
    for (const init of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
      icon.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
    }
    other.icon.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("click"));
    expect(back).not.toHaveBeenCalled();

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    icon.dispatchEvent(click);
    expect(back).toHaveBeenCalledTimes(1);
    expect(click.defaultPrevented).toBe(true);
  });
});
