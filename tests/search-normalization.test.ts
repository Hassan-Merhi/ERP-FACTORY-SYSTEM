import { describe, expect, it } from "vitest";
import { normalizeSearchText, searchAny, searchEquals, searchIncludes } from "@shared/searchNormalization";

describe("search normalization", () => {
  it("ignores spaces, dots, hyphens, slashes, underscores and other punctuation", () => {
    expect(normalizeSearchText("AB-123.45 / X_Y")).toBe("ab12345xy");
    expect(searchIncludes("MRKU-2668517", "mrku 2668517")).toBe(true);
    expect(searchIncludes("INV.2026/09-001", "inv 2026 09 001")).toBe(true);
    expect(searchEquals("A-B.C_123", "abc123")).toBe(true);
  });

  it("keeps multilingual normalization while removing separators", () => {
    expect(searchIncludes("كِيس-كريمى ١٢٣", "كيس كريمي123")).toBe(true);
    expect(searchIncludes("Café-du Monde", "cafe du monde")).toBe(true);
  });

  it("matches any supplied field and treats a blank query as unfiltered", () => {
    expect(searchAny("ab 12", "Other", "AB-12.34")).toBe(true);
    expect(searchAny("", "anything")).toBe(true);
  });
});
