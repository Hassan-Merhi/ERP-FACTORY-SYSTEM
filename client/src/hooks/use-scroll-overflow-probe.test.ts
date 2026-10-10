import { describe, expect, it } from "vitest";
import { readScrollOverflow } from "./use-scroll-overflow-probe";

function strip({
  scrollWidth,
  clientWidth,
  scrollLeft,
}: {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}) {
  return { scrollWidth, clientWidth, scrollLeft } as unknown as HTMLElement;
}

describe("readScrollOverflow", () => {
  it("reports none for a strip that fits", () => {
    expect(readScrollOverflow(strip({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 }))).toBe("none");
    expect(readScrollOverflow(strip({ scrollWidth: 301, clientWidth: 300, scrollLeft: 0 }))).toBe("none");
  });

  it("fades the trailing edge at the start and the leading edge at the end", () => {
    expect(readScrollOverflow(strip({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 }))).toBe("end");
    expect(readScrollOverflow(strip({ scrollWidth: 500, clientWidth: 300, scrollLeft: 200 }))).toBe("start");
    expect(readScrollOverflow(strip({ scrollWidth: 500, clientWidth: 300, scrollLeft: 199.5 }))).toBe("start");
  });

  it("fades both edges mid-scroll, including RTL negative offsets", () => {
    expect(readScrollOverflow(strip({ scrollWidth: 500, clientWidth: 300, scrollLeft: 80 }))).toBe("both");
    expect(readScrollOverflow(strip({ scrollWidth: 500, clientWidth: 300, scrollLeft: -80 }))).toBe("both");
    expect(readScrollOverflow(strip({ scrollWidth: 500, clientWidth: 300, scrollLeft: -200 }))).toBe("start");
  });
});
