import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

describe("factory customer proforma summary payload", () => {
  it("keeps summaries line-free and preserves the lazy detail route", () => {
    const server = readModuleFamily("server/routes/factory/customer-proformas/proformas.ts");
    const client = readModuleFamily("client/src/pages/factory/FactoryPendingLoadings.tsx");
    const invoiceDetailPath = "client/src/pages/factory/factoryinvoicedetail/useFactoryInvoiceDetailModel.tsx";
    const pendingVerifyPath =
      "client/src/pages/factory/factorypendinginvoiceverify/useFactoryPendingInvoiceVerifyModel.tsx";
    const invoiceDetail = readModuleFamily(invoiceDetailPath);
    const pendingVerify = readModuleFamily(pendingVerifyPath);

    expect(server).toContain('profile === "summary"');
    expect(server).toContain("lines: []");
    expect(server).toContain('app.get("/api/factory/customer-proformas/:id"');
    expect(server).toContain("lines: enrichedLines");
    expect(client).toContain("profile=summary");

    for (const source of [invoiceDetail, pendingVerify]) {
      expect(source).toContain("profile=summary");
      expect(source).toContain("showProformaDialog && !!selectedProformaId");
      expect(source.includes("/api/factory/customer-proformas/${selectedProformaId}")).toBe(true);
    }
  });
});
