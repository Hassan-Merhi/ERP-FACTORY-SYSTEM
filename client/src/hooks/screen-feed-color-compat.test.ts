import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeUnsupportedScreenFeedColors } from "./screen-feed-color-compat";

describe("screen-feed unsupported CSS colors", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalComputedStyle = window.getComputedStyle;

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    window.getComputedStyle = originalComputedStyle;
    document.querySelectorAll("[data-test-capture-color]").forEach((node) => node.remove());
  });

  it("converts computed oklab and oklch into canvas-rendered sRGB on the clone", () => {
    const element = document.createElement("div");
    element.setAttribute("data-test-capture-color", "true");
    document.body.appendChild(element);

    const seen: string[] = [];
    HTMLCanvasElement.prototype.getContext = function () {
      return {
        clearRect: () => undefined,
        fillRect: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray([14, 100, 192, 255]) }),
        set fillStyle(color: string) {
          seen.push(color);
        },
      } as unknown as CanvasRenderingContext2D;
    } as HTMLCanvasElement["getContext"];

    window.getComputedStyle = vi.fn((target: Element) => {
      if (target !== element) return originalComputedStyle.call(window, target);
      return {
        getPropertyValue: (property: string) => {
          if (property === "color") return "oklab(70% 0.1 -0.05)";
          if (property === "background-image") {
            return "linear-gradient(to right, oklch(65% 0.1 45), oklab(70% 0.1 -0.05))";
          }
          return "";
        },
      } as CSSStyleDeclaration;
    }) as typeof window.getComputedStyle;

    normalizeUnsupportedScreenFeedColors(document);

    expect(seen).toContain("oklab(70% 0.1 -0.05)");
    expect(seen).toContain("oklch(65% 0.1 45)");
    expect(element.style.getPropertyValue("color")).toBe("rgb(14, 100, 192)");
    expect(element.style.getPropertyValue("background-image")).not.toContain("oklab");
    expect(element.style.getPropertyValue("background-image")).not.toContain("oklch");
    expect(element.style.getPropertyPriority("color")).toBe("important");
  });

  it("does not modify pages that have no unsupported CSS color functions", () => {
    const element = document.createElement("div");
    element.setAttribute("data-test-capture-color", "true");
    document.body.appendChild(element);
    HTMLCanvasElement.prototype.getContext = function () {
      return {
        clearRect: () => undefined,
        fillRect: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) }),
        set fillStyle(_color: string) {
          throw new Error("should not convert a normal color");
        },
      } as unknown as CanvasRenderingContext2D;
    } as HTMLCanvasElement["getContext"];
    element.style.color = "rgb(1, 2, 3)";
    normalizeUnsupportedScreenFeedColors(document);
    expect(element.style.getPropertyValue("color")).toBe("rgb(1, 2, 3)");
  });
});
