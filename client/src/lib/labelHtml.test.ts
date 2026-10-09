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
  it("colors only the small HMD lettering using the original assigned red", () => {
    const bale = label({ priorityColor: "#dc2626", priorityOrderId: 123, priorityNumber: 1 });
    for (const html of [
      generateCombinedLabelsHtml([bale]),
      generateA5LabelsHtml([bale]),
      generateStickerLabelsHtml([bale]),
    ]) {
      expect(html).toContain("priority-hmd-letters");
      expect(html).toContain("color:#dc2626 !important");
      expect(html).toContain("INTERNATIONAL GROUP");
      expect(html).toContain("REF-001");
      expect(html).toContain("ART-100");
    }
  });

  it("uses the new HMD globe artwork layout on priority A4 and A5", () => {
    const bale = label({ priorityColor: "#16a34a" });
    expect(generateCombinedLabelsHtml([bale])).toContain('class="a4-page priority-print-a4"');
    expect(generateA5LabelsHtml([bale])).toContain('class="a5-page priority-print-a5"');
  });

  it("leaves the original normal layout unchanged without a priority assignment", () => {
    const html = generateCombinedLabelsHtml([label()]);
    expect(html).not.toContain('class="a4-page priority-print-a4"');
    expect(html).toContain('class="a4-page"');
  });

  it("does not inject arbitrary CSS through a malformed priority color", () => {
    const html = generateStickerLabelsHtml([label({ priorityColor: "red; position:absolute" })]);
    expect(html).not.toContain("red; position:absolute");
  });
});
