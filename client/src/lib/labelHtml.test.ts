/**
 * Printed stock labels.
 *
 * These three generators produce the HTML that goes to a printer and ends up
 * stuck on a bale: a barcode, the reference number under it, the article code,
 * the piece count and the approximate weight. A label that prints the wrong
 * reference number under a barcode is worse than one that fails to print, and
 * nothing here was covered beyond the number formatter.
 */
import { describe, expect, it } from "vitest";
import {
  A4_DESIGN_OPTIONS,
  formatLabelNum,
  generateA5LabelsHtml,
  generateCombinedLabelsHtml,
  generateStickerLabelsHtml,
  priorityLogoTextStyleAttr,
  resolvePriorityLabelColor,
  validatePriorityLabelColor,
  type LabelData,
} from "./labelHtml";

function label(overrides: Partial<LabelData> = {}): LabelData {
  return {
    referenceNumber: "REF-001",
    articleCode: "ART-100",
    pieces: 12,
    approxWeightKg: "45.5",
    productName: "Rice 5kg",
    ...overrides,
  };
}

describe("label numbers", () => {
  it("prints a whole number without decimals", () => {
    expect(formatLabelNum(12)).toBe("12");
    expect(formatLabelNum("40.000")).toBe("40");
  });

  it("keeps up to three decimals for a fractional weight", () => {
    expect(formatLabelNum("45.5")).toBe("45.5");
    expect(formatLabelNum(45.6789)).toBe("45.679");
  });

  it("passes text through unchanged when it is not a number", () => {
    // Better a label showing what it was given than one showing NaN.
    expect(formatLabelNum("N/A")).toBe("N/A");
  });
});

describe("A4 labels", () => {
  it("prints one page per label", () => {
    const html = generateCombinedLabelsHtml([label(), label({ referenceNumber: "REF-002" })]);

    expect(html.match(/class="a4-page"/g)).toHaveLength(2);
    expect(html).toContain("REF-001");
    expect(html).toContain("REF-002");
  });

  it("puts the reference, article, pieces and weight on the label", () => {
    const html = generateCombinedLabelsHtml([label()]);

    expect(html).toContain("ART-100");
    expect(html).toContain(">12<");
    expect(html).toContain("45.5 KGS");
    expect(html).toContain("Rice 5kg");
  });

  it("falls back to the barcode endpoint when no image was prefetched", () => {
    const html = generateCombinedLabelsHtml([label({ referenceNumber: "REF/001 A" })]);

    // The reference goes into a URL, so it has to be encoded or a reference
    // containing a slash would request a different path entirely.
    expect(html).toContain("/api/barcode/REF%2F001%20A");
  });

  it("uses a prefetched barcode image when one is supplied", () => {
    const html = generateCombinedLabelsHtml([label({ barcodeDataUrl: "data:image/png;base64,AAA" })]);

    expect(html).toContain("data:image/png;base64,AAA");
    expect(html).not.toContain("/api/barcode/REF-001");
  });

  it("prefers the customer logo over the house logo", () => {
    const html = generateCombinedLabelsHtml([label({ customerLogoUrl: "https://example.test/logo.png" })]);

    expect(html).toContain("https://example.test/logo.png");
  });

  it("lets a label choose its own banner over the batch default", () => {
    const [first, second] = A4_DESIGN_OPTIONS;
    const html = generateCombinedLabelsHtml([label({ designColor: second.value })], first.value);

    // Printing uses the full-resolution original, never the thumbnail the
    // picker shows on screen.
    expect(html).toContain(`/labels/hmd-${second.value}.jpg`);
    expect(html).not.toContain(`/labels/hmd-${first.value}.jpg`);
    expect(html).not.toContain("previews/");
  });

  it("produces a printable document for an empty batch", () => {
    const html = generateCombinedLabelsHtml([]);

    expect(html).toContain("<html>");
    expect(html).not.toContain('class="a4-page"');
  });
});

describe("A5 and sticker labels", () => {
  it("prints every A5 label with its own reference", () => {
    const html = generateA5LabelsHtml([label(), label({ referenceNumber: "REF-002" })]);

    expect(html).toContain("REF-001");
    expect(html).toContain("REF-002");
    expect(html).toContain("Rice 5kg");
  });

  it("prints every sticker with its own reference", () => {
    const html = generateStickerLabelsHtml([label(), label({ referenceNumber: "REF-002" })]);

    expect(html).toContain("REF-001");
    expect(html).toContain("REF-002");
    expect(html).toContain("ART-100");
  });

  it("sets a page size on each layout so the printer does not guess", () => {
    expect(generateCombinedLabelsHtml([label()])).toContain("@page");
    expect(generateA5LabelsHtml([label()])).toContain("@page");
    expect(generateStickerLabelsHtml([label()])).toContain("@page");
  });
});

describe("Automatic Priority Printing labels", () => {
  const printers = [generateCombinedLabelsHtml, generateA5LabelsHtml, generateStickerLabelsHtml];

  function stripPriorityLogo(html: string): string {
    return html
      .replace(/<svg class="[^"]*priority-hmd-logo"[\s\S]*?<\/svg>/g, "<LOGO>")
      .replace(/<img class="(?:logo-img|sticker-logo)"[^>]*\/>/g, "<LOGO>");
  }

  it("colors only the small HMD artwork inside the barcode box with the saved red", () => {
    const bale = label({ priorityColor: "#dc2626", priorityOrderId: 123, priorityNumber: 1 });
    for (const print of printers) {
      const html = print([bale]);
      // One recolored small logo; the letters layer gets the color, the
      // INTERNATIONAL GROUP subtitle layer stays black.
      expect(html.match(/class="(?:logo-img|sticker-logo) priority-hmd-logo"/g)).toHaveLength(1);
      expect(html).toContain('data-priority-color="#dc2626"');
      expect(html).toContain("0 0 0 0 0.8627 0 0 0 0 0.1490 0 0 0 0 0.1490");
      expect(html).toContain("0 0 0 0 0 0 0 0 0 0 0 0 0 0 0");
      expect(html.match(/class="priority-hmd-letters"/g)).toHaveLength(1);
      expect(html).toContain("REF-001");
      expect(html).toContain("ART-100");
      expect(html).toContain("/api/barcode/REF-001");
    }
  });

  it("keeps the exact ordinary A4/A5/sticker layout and large HMD banners for priority bales", () => {
    const [design] = A4_DESIGN_OPTIONS;
    const ordinary = label({ designColor: design.value });
    const priority = label({ designColor: design.value, priorityColor: "#2563eb" });
    for (const print of printers) {
      expect(stripPriorityLogo(print([priority]))).toBe(stripPriorityLogo(print([ordinary])));
    }
    // The large banner artwork is still printed twice per A4 page.
    const a4 = generateCombinedLabelsHtml([priority]);
    expect(a4.match(new RegExp(`/labels/hmd-${design.value}.jpg`, "g"))).toHaveLength(2);
    expect(a4).not.toContain("priority-print-a4");
    expect(a4).not.toMatch(/stripe/i);
    expect(generateA5LabelsHtml([priority])).toContain("a5-page a5-page1");
  });

  it("leaves ordinary labels with their original logo markup", () => {
    for (const print of printers) {
      const html = print([label({ customerLogoUrl: "https://example.test/logo.png" })]);
      expect(html).toContain('src="https://example.test/logo.png" alt="Logo"');
      expect(html).not.toContain('class="priority-hmd-letters"');
    }
  });

  it("rejects invalid colors instead of printing a misleading priority label", () => {
    const malicious = label({ priorityColor: "red; position:absolute" });
    expect(resolvePriorityLabelColor(malicious.priorityColor)).toBeNull();
    for (const print of printers) {
      expect(() => print([malicious])).toThrow(/Unrecognized Priority Scan label color/);
    }
  });

  it("supports the exact hex and named priority colors configured in loading settings", () => {
    expect(resolvePriorityLabelColor("#DC2626")).toBe("#dc2626");
    expect(resolvePriorityLabelColor("#abc")).toBe("#aabbcc");
    expect(resolvePriorityLabelColor("Red")).toBe("#dc2626");
    expect(resolvePriorityLabelColor("Blue")).toBe("#2563eb");
    expect(resolvePriorityLabelColor("Green")).toBe("#16a34a");
    expect(resolvePriorityLabelColor("Navy")).toBe("#000080");
    expect(resolvePriorityLabelColor("Lime")).toBe("#00ff00");
    expect(resolvePriorityLabelColor("rgb(0,0,0);position:absolute")).toBeNull();
    expect(validatePriorityLabelColor(label())).toBeNull();
  });

  it("keeps sticker dimensions, article and reference unchanged", () => {
    const html = generateStickerLabelsHtml([label({ priorityColor: "Blue", priorityNumber: 2 })]);
    expect(html).toContain("@page { size: 3in 1.97in");
    expect(html).toContain('data-priority-color="#2563eb"');
    expect(html).toContain('class="ref-barcode-img"');
    expect(html).toContain("REF-001");
    expect(html).toContain("ART-100");
    expect(html).toContain("45.5 KGS");
  });

  it("handles mixed batches without applying a previous bale's priority color to ordinary labels", () => {
    const items = [
      label({ referenceNumber: "PRIORITY-01", priorityColor: "#dc2626" }),
      label({ referenceNumber: "NORMAL-02" }),
      label({ referenceNumber: "PRIORITY-03", priorityColor: "#2563eb" }),
    ];
    for (const print of printers) {
      const html = print(items);
      expect(html.match(/class="priority-hmd-letters"/g)).toHaveLength(2);
      expect(html).toContain('data-priority-color="#dc2626"');
      expect(html).toContain('data-priority-color="#2563eb"');
      const normal = html.slice(html.indexOf("NORMAL-02") - 3000, html.indexOf("NORMAL-02"));
      expect(normal).not.toContain("priority-hmd-logo");
      // SVG filter ids must be unique within one print document.
      const ids = [...html.matchAll(/filter id="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("renders product text as escaped content", () => {
    const maliciousName = "PANT <img src=x onerror=alert(1)>";
    for (const print of printers) {
      const html = print([label({ priorityColor: "#dc2626", productName: maliciousName })]);
      expect(html).not.toContain("PANT <img src=x");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
  });
});

describe("legacy Pressing/Production text logo", () => {
  it("colors only the HMD text for a priority bale and leaves ordinary labels untouched", () => {
    expect(priorityLogoTextStyleAttr({ referenceNumber: "R1" })).toBe("");
    const attr = priorityLogoTextStyleAttr({ referenceNumber: "R1", priorityColor: "Blue" });
    expect(attr).toContain("color: #2563eb");
    expect(attr).toContain('data-priority-color="#2563eb"');
    expect(() => priorityLogoTextStyleAttr({ referenceNumber: "R1", priorityColor: "url(x)" })).toThrow(
      /Unrecognized Priority Scan label color/
    );
  });
});
