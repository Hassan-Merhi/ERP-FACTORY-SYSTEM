/**
 * Four small client helpers:
 *
 * - normalizeRetailImageUrl(s): product photos never keep a host name and
 *   always point at the retail media route.
 * - formatMoneyDisplay / formatMoneyNumber: explicit-currency display with
 *   no FX conversion.
 * - findScopedTestId / focusScopedTestId: focus the field inside the form,
 *   dialog or main area the user is working in, preferring a visible match.
 * - installForcedApiRefresh: a click on a refresh control makes the next API
 *   GETs bypass every cache.
 */
import { normalizeRetailImageUrl, normalizeRetailImageUrls } from "@/lib/retailImageUrl";
import { formatMoneyDisplay, formatMoneyNumber } from "@/lib/moneyDisplay";
import { findScopedTestId, focusScopedTestId } from "@/lib/scopedFocus";
import { installForcedApiRefresh } from "@/lib/forcedApiRefresh";

describe("normalizeRetailImageUrl", () => {
  it.each([
    [undefined, ""],
    [null, ""],
    ["   ", ""],
    ["https://old-host.example/api/files/42/preview", "/api/retail/media/42"],
    ["/api/files/42/preview/?v=3#top", "/api/retail/media/42"],
    ["HTTP://x.example/api/retail/media/7/", "/api/retail/media/7"],
    ["/api/retail/media/7?size=thumb", "/api/retail/media/7"],
    ["/api/files/42/download", "/api/files/42/download"],
    ["data:image/png;base64,AAAA", "data:image/png;base64,AAAA"],
    ["https://[bad", "https://[bad"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeRetailImageUrl(input)).toBe(expected);
  });

  it("normalizes a list, dropping blanks and duplicates in order", () => {
    expect(
      normalizeRetailImageUrls([
        "/api/files/1/preview",
        "",
        null,
        "https://a.example/api/retail/media/1",
        "/api/retail/media/2",
      ])
    ).toEqual(["/api/retail/media/1", "/api/retail/media/2"]);
    expect(normalizeRetailImageUrls(undefined)).toEqual([]);
  });
});

describe("money display", () => {
  it("shows the placeholder for missing or non-numeric amounts", () => {
    expect(formatMoneyDisplay(null, { currency: "USD" })).toBe("—");
    expect(formatMoneyDisplay("", { currency: "USD", placeholder: "n/a" })).toBe("n/a");
    expect(formatMoneyDisplay("abc", { currency: "USD" })).toBe("—");
    expect(formatMoneyDisplay(Number.NaN, { currency: "USD" })).toBe("—");
  });

  it("shows Kwacha ngwee by default and trims other currencies", () => {
    expect(formatMoneyDisplay(250, { currency: " zmw " })).toMatch(/250\.00$/);
    expect(formatMoneyDisplay("1234.5", { currency: "USD" })).toMatch(/1,234\.5$/);
    expect(
      formatMoneyDisplay(1.23456, { currency: "USD", maximumFractionDigits: 3, minimumFractionDigits: 3 })
    ).toMatch(/1\.235$/);
  });

  it("formats bare numbers with bounded decimals", () => {
    expect(formatMoneyNumber(undefined)).toBe("—");
    expect(formatMoneyNumber("")).toBe("—");
    expect(formatMoneyNumber("x")).toBe("—");
    expect(formatMoneyNumber(" 1234.567 ")).toBe("1,234.57");
    expect(formatMoneyNumber(1234.567, 0)).toBe("1,235");
    expect(formatMoneyNumber(1.5, -3)).toBe("2");
    expect(formatMoneyNumber(1.5, 99)).toBe("1.5");
  });
});

describe("scoped focus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function visible(el: HTMLElement) {
    vi.spyOn(el, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    return el;
  }

  it("prefers the match inside the form the anchor belongs to", () => {
    document.body.innerHTML = `
      <form id="a"><input data-testid="qty" id="qa" /><button id="anchor"></button></form>
      <form id="b"><input data-testid="qty" id="qb" /></form>`;
    visible(document.getElementById("qb")!);

    expect(findScopedTestId("qty", document.getElementById("anchor"))?.id).toBe("qa");
  });

  it("falls back to the document, preferring a visible match", () => {
    document.body.innerHTML = `<input data-testid="qty" id="hidden" /><input data-testid="qty" id="shown" />`;
    visible(document.getElementById("shown")!);

    expect(findScopedTestId("qty")?.id).toBe("shown");
  });

  it("returns the first match when none is visible, and null when none exists", () => {
    document.body.innerHTML = `<input data-testid="qty" id="one" /><input data-testid="qty" id="two" />`;

    expect(findScopedTestId("qty")?.id).toBe("one");
    expect(findScopedTestId("missing")).toBeNull();
  });

  it("escapes test ids that contain quotes", () => {
    const input = document.createElement("input");
    input.dataset.testid = 'row "3"';
    document.body.append(input);

    expect(findScopedTestId('row "3"')).toBe(input);
  });

  it("focuses and selects on the next frame, or after a delay", () => {
    document.body.innerHTML = `<input data-testid="qty" value="12" /><div data-testid="box" tabindex="0"></div>`;
    const input = document.querySelector<HTMLInputElement>("input")!;
    const select = vi.spyOn(input, "select");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    focusScopedTestId("qty", { select: true });
    expect(document.activeElement).toBe(input);
    expect(select).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    focusScopedTestId("box", { delay: 50, select: true });
    expect(document.activeElement).toBe(input);
    vi.advanceTimersByTime(50);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("box");

    expect(() => focusScopedTestId("missing")).not.toThrow();
  });
});

describe("installForcedApiRefresh", () => {
  type Flagged = Window & { __forcedApiRefreshInstalled?: boolean };
  const realFetch = window.fetch;

  afterEach(() => {
    window.fetch = realFetch;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  function install() {
    const inner = vi.fn(async () => new Response("{}"));
    window.fetch = inner as typeof fetch;
    delete (window as Flagged).__forcedApiRefreshInstalled;
    installForcedApiRefresh();
    return inner;
  }

  it("leaves requests alone until a refresh control is clicked", async () => {
    const inner = install();

    await window.fetch("/api/items", { headers: { a: "1" } });

    expect(inner).toHaveBeenCalledWith("/api/items", { headers: { a: "1" } });
  });

  it("forces API GETs to reload for a moment after a refresh click", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const inner = install();
    const button = document.createElement("button");
    button.dataset.testid = "button-refresh";
    document.body.append(button);
    button.click();

    await window.fetch("/api/items?page=2");
    await window.fetch(new URL("/api/items", window.location.origin));
    await window.fetch(new Request(`${window.location.origin}/api/items`, { headers: { b: "2" } }));
    await window.fetch("/api/items", { method: "POST" });
    await window.fetch("/assets/app.js");

    const calls = inner.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>;
    expect(String(calls[0][0])).toMatch(/\/api\/items\?page=2&__refresh=1$/);
    expect(calls[0][1].cache).toBe("reload");
    expect(calls[1][0]).toBeInstanceOf(URL);
    expect((calls[1][0] as URL).searchParams.get("__refresh")).toBe("1");
    expect((calls[2][0] as Request).url).toMatch(/__refresh=1$/);
    expect(new Headers(calls[2][1].headers).get("b")).toBe("2");
    expect(calls[3][1]).toEqual({ method: "POST" });
    expect(calls[4][1]).toBeUndefined();

    vi.setSystemTime(Date.now() + 1_000);
    await window.fetch("/api/items");
    expect(calls[5][1]).toBeUndefined();
  });

  it("installs only once", () => {
    install();
    const wrapped = window.fetch;

    installForcedApiRefresh();

    expect(window.fetch).toBe(wrapped);
  });
});
