/**
 * Two small shell hooks.
 *
 * useServerRestart (development only) polls /api/boot and reloads once the
 * server's boot id changes, so a restarted dev server never serves a stale tab.
 *
 * useMainContentFocus moves focus to #main-content after each route change so
 * scrolling works at once — but never away from a form field or an open
 * overlay, and never to a hidden or unfocusable element.
 */
import React from "react";
import { render, renderHook } from "@testing-library/react";
import { useServerRestart } from "@/hooks/use-server-restart";
import { useMainContentFocus } from "@/hooks/use-main-content-focus";
import { installFakeApi, respond } from "./fakeApi";

describe("useServerRestart", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const boots = (api: ReturnType<typeof installFakeApi>) => api.callsTo("GET", "/api/boot").length;

  it("polls every 8 seconds and stops polling once the boot id changes", async () => {
    const api = installFakeApi();
    const ids = ["boot-a", "boot-a", "boot-b"];
    api.get("/api/boot", () => ({ bootId: ids.shift() ?? "boot-b" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() => useServerRestart());

    expect(boots(api)).toBe(0);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(boots(api)).toBe(2);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(boots(api)).toBe(3);

    await vi.advanceTimersByTimeAsync(24_000);
    expect(boots(api)).toBe(3);
  });

  it("keeps polling through errors and an unready server", async () => {
    const api = installFakeApi();
    let attempt = 0;
    api.get("/api/boot", () => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new TypeError("Failed to fetch"));
      if (attempt === 2) return respond(503, {});
      return { bootId: "boot-a" };
    });
    renderHook(() => useServerRestart());

    await vi.advanceTimersByTimeAsync(8_000 * 4);

    expect(boots(api)).toBe(4);
  });

  it("stops polling on unmount", async () => {
    const api = installFakeApi();
    api.get("/api/boot", { bootId: "boot-a" });
    const { unmount } = renderHook(() => useServerRestart());

    unmount();
    await vi.advanceTimersByTimeAsync(8_000 * 3);

    expect(boots(api)).toBe(0);
  });
});

describe("useMainContentFocus", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function Shell({ location, skip, children }: { location: string; skip?: boolean; children?: React.ReactNode }) {
    useMainContentFocus(location, skip);
    return (
      <>
        <main id="main-content" tabIndex={-1} data-testid="main" />
        {children}
      </>
    );
  }

  it("focuses the main content after a route change", () => {
    const { getByTestId, rerender } = render(<Shell location="/a" />);
    getByTestId("main").blur();

    rerender(<Shell location="/b" />);

    expect(document.activeElement).toBe(getByTestId("main"));
  });

  it("leaves focus in a form field the user is typing in", () => {
    const { getByTestId, rerender } = render(
      <Shell location="/a">
        <input data-testid="field" />
      </Shell>
    );
    getByTestId("field").focus();

    rerender(
      <Shell location="/b">
        <input data-testid="field" />
      </Shell>
    );

    expect(document.activeElement).toBe(getByTestId("field"));
  });

  it("does not steal focus from an open dialog, but ignores a closed one", () => {
    const { getByTestId, rerender } = render(
      <Shell location="/a">
        <div role="dialog" data-state="open" />
      </Shell>
    );
    getByTestId("main").blur();
    rerender(
      <Shell location="/b">
        <div role="dialog" data-state="open" />
      </Shell>
    );
    expect(document.activeElement).not.toBe(getByTestId("main"));

    rerender(
      <Shell location="/c">
        <div role="dialog" data-state="closed" />
      </Shell>
    );
    expect(document.activeElement).toBe(getByTestId("main"));
  });

  it("skips when asked, or when the main content is hidden", () => {
    const { getByTestId, rerender } = render(<Shell location="/a" skip />);
    getByTestId("main").blur();
    rerender(<Shell location="/b" skip />);
    expect(document.activeElement).not.toBe(getByTestId("main"));

    // jsdom will not focus a hidden element on its own, so watch the call itself.
    const main = getByTestId("main");
    main.hidden = true;
    const focus = vi.spyOn(main, "focus");
    rerender(<Shell location="/c" />);
    expect(focus).not.toHaveBeenCalled();
  });

  it("does nothing when there is no main content", () => {
    function Bare({ location }: { location: string }) {
      useMainContentFocus(location);
      return <button data-testid="button" />;
    }
    const { getByTestId, rerender } = render(<Bare location="/a" />);
    getByTestId("button").focus();

    rerender(<Bare location="/b" />);

    expect(document.activeElement).toBe(getByTestId("button"));
  });
});
