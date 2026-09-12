import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SafeStyle } from "@/components/SafeStyle";

describe("SafeStyle", () => {
  it("renders CSS as inert text that cannot break out of the style element", () => {
    const hostile = `</style><img src="x" onerror="window.__xss='pwned'"><style>body { color: red; }`;
    const { container } = render(<SafeStyle css={hostile} />);

    // No element is ever created from the CSS payload: the breakout attempt
    // stays literal text inside the single <style> node.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("style")).toHaveLength(1);
    expect(container.querySelector("style")?.textContent).toBe(hostile);
    expect((window as unknown as { __xss?: string }).__xss).toBeUndefined();
  });

  it("renders ordinary print CSS unchanged", () => {
    const css = `@media print {
  body { font-family: Arial, Helvetica, sans-serif !important; }
}`;
    const { container } = render(<SafeStyle css={css} />);
    // getByText ignores <style> nodes, so assert on the element directly.
    expect(container.querySelector("style")?.textContent).toBe(css);
  });
});
