/**
 * useScrollOverflowProbe marks sideways-scrolling tab strips with
 * data-scroll-overflow so CSS can fade the edge that still hides tabs. It must
 * track strips already present, strips mounted later, scroll and resize, wait
 * for a late root, and clean every attribute up on unmount.
 */
import React, { useRef } from "react";
import { act, render } from "@testing-library/react";
import { readScrollOverflow, useScrollOverflowProbe } from "@/hooks/use-scroll-overflow-probe";

type Geometry = { scrollWidth: number; clientWidth: number; scrollLeft: number };

const resizeCallbacks: Array<(entries: Array<{ target: Element }>) => void> = [];
const observed = new Set<Element>();

class FakeResizeObserver {
  constructor(private readonly callback: (entries: Array<{ target: Element }>) => void) {
    resizeCallbacks.push(callback);
  }
  observe(el: Element) {
    observed.add(el);
  }
  unobserve(el: Element) {
    observed.delete(el);
  }
  disconnect() {
    observed.clear();
  }
}

function setGeometry(el: HTMLElement, geometry: Geometry) {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(el, key, { configurable: true, writable: true, value });
  }
}

function strip(testId: string) {
  return <div data-testid={testId} data-responsive-tabs="true" />;
}

function Probe({ children, rootAvailable = true }: { children: React.ReactNode; rootAvailable?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollOverflowProbe(ref);
  return rootAvailable ? <div ref={ref}>{children}</div> : <div>{children}</div>;
}

const realResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  resizeCallbacks.length = 0;
  observed.clear();
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  vi.useRealTimers();
});

describe("readScrollOverflow", () => {
  it.each([
    [{ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 }, "none"],
    [{ scrollWidth: 600, clientWidth: 300, scrollLeft: 0 }, "end"],
    [{ scrollWidth: 600, clientWidth: 300, scrollLeft: 300 }, "start"],
    [{ scrollWidth: 600, clientWidth: 300, scrollLeft: 120 }, "both"],
    [{ scrollWidth: 600, clientWidth: 300, scrollLeft: -300 }, "start"],
  ])("%j → %s", (geometry, expected) => {
    const el = document.createElement("div");
    setGeometry(el, geometry);
    expect(readScrollOverflow(el)).toBe(expected);
  });
});

describe("useScrollOverflowProbe", () => {
  it("marks strips present on mount and updates them on scroll", () => {
    const { getByTestId } = render(<Probe>{strip("tabs")}</Probe>);
    const tabs = getByTestId("tabs");
    expect(tabs.getAttribute("data-scroll-overflow")).toBe("none");

    setGeometry(tabs, { scrollWidth: 600, clientWidth: 300, scrollLeft: 150 });
    act(() => {
      tabs.dispatchEvent(new Event("scroll"));
    });

    expect(tabs.getAttribute("data-scroll-overflow")).toBe("both");
    expect(observed.has(tabs)).toBe(true);
  });

  it("updates a strip when it is resized", () => {
    const { getByTestId } = render(<Probe>{strip("tabs")}</Probe>);
    const tabs = getByTestId("tabs");
    setGeometry(tabs, { scrollWidth: 900, clientWidth: 300, scrollLeft: 0 });

    act(() => resizeCallbacks[0]([{ target: tabs }]));

    expect(tabs.getAttribute("data-scroll-overflow")).toBe("end");
  });

  it("ignores scrolling outside the tracked strips", () => {
    const { getByTestId } = render(
      <Probe>
        {strip("tabs")}
        <div data-testid="plain" />
      </Probe>
    );
    const plain = getByTestId("plain");
    setGeometry(plain, { scrollWidth: 600, clientWidth: 300, scrollLeft: 100 });

    act(() => {
      plain.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(plain.hasAttribute("data-scroll-overflow")).toBe(false);
  });

  it("picks up strips mounted later and forgets removed ones", async () => {
    function Later({ show }: { show: boolean }) {
      return <Probe>{show ? strip("late") : <span />}</Probe>;
    }
    const { rerender, getByTestId } = render(<Later show={false} />);

    rerender(<Later show />);
    await act(async () => {});
    const late = getByTestId("late");
    expect(late.getAttribute("data-scroll-overflow")).toBe("none");
    expect(observed.has(late)).toBe(true);

    rerender(<Later show={false} />);
    await act(async () => {});
    expect(observed.has(late)).toBe(false);
  });

  it("waits for a root that is not mounted yet", () => {
    vi.useFakeTimers();
    function LateRoot() {
      const ref = useRef<HTMLDivElement | null>(null);
      useScrollOverflowProbe(ref);
      const [ready, setReady] = React.useState(false);
      React.useEffect(() => {
        const timer = setTimeout(() => setReady(true), 200);
        return () => clearTimeout(timer);
      }, []);
      return ready ? <div ref={ref}>{strip("tabs")}</div> : null;
    }
    const { getByTestId } = render(<LateRoot />);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(getByTestId("tabs").getAttribute("data-scroll-overflow")).toBe("none");
  });

  it("removes its attributes and stops observing on unmount", () => {
    const { getByTestId, unmount } = render(<Probe>{strip("tabs")}</Probe>);
    const tabs = getByTestId("tabs");

    unmount();

    expect(tabs.hasAttribute("data-scroll-overflow")).toBe(false);
    expect(observed.size).toBe(0);
  });

  it("does nothing where ResizeObserver is unavailable", () => {
    globalThis.ResizeObserver = undefined as never;
    const { getByTestId } = render(<Probe>{strip("tabs")}</Probe>);

    expect(getByTestId("tabs").hasAttribute("data-scroll-overflow")).toBe(false);
  });
});
