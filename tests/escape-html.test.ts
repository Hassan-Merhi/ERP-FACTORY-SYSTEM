/**
 * escapeHtml is applied to every user-entered value in the server-rendered
 * loading reports (bale references, article codes, product, customer, truck
 * and driver names), so stored text cannot inject markup or script.
 */
import { describe, expect, it } from "vitest";

import { escapeHtml } from "../server/lib/escapeHtml";

describe("escapeHtml", () => {
  it("escapes markup and quote characters", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;"
    );
  });

  it("renders null and undefined as empty and stringifies other values", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});
