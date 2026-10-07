/**
 * The printable loading-session report escapes user-entered text, so a bale
 * or product name containing markup cannot run script in the report page.
 */
import { describe, expect, it } from "vitest";

import { renderSessionLoadingReportHtml } from "../server/routes/factory/invoice-loading/reportHtml";

const payload = `<script>alert("x")</script>`;

describe("loading session report HTML", () => {
  it("escapes stored names and keeps weights exact", () => {
    const html = renderSessionLoadingReportHtml({
      pdfTitle: "",
      session: { id: 7, invoiceId: 3, status: "OPEN", truckNo: payload, driverName: null, notes: null },
      invoice: { invoiceNumber: "INV-1", customerName: payload },
      sessionBales: [{ baleReference: payload, articleCode: "A1", productName: payload, weightKg: "0.100" }],
      remainingBales: [{ baleReference: "B2", articleCode: null, productName: null, weightKg: "0.200" }],
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("0.100");
    expect(html).toContain("0.200 kg");
  });
});
