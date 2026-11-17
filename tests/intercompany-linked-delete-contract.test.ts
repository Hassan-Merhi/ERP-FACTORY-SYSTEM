import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const service = readFileSync("server/services/intercompany/linkedTradePhysicalDelete.ts", "utf8");
const daybook = readFileSync("client/src/pages/Daybook.tsx", "utf8");
const routes = readFileSync("server/routes/import/intercompany-phase5.ts", "utf8");
const importService = readFileSync("server/services/intercompany/containerTradingImport.ts", "utf8");
const storage = readFileSync("server/storage/containers-store/containers.ts", "utf8");
const pagination = readFileSync("server/routes/containers/containerListPaginationRoutes.ts", "utf8");

describe("linked intercompany container and Daybook deletion contract", () => {
  it("records every original source and destination voucher ID on import", () => {
    for (const name of [
      "originalSupplierVoucherIds",
      "sourceSaleVoucherId",
      "sourceCostVoucherId",
      "destinationVoucherId",
    ]) {
      expect(importService).toContain(name);
      expect(service).toContain(name);
    }
    expect(service).toContain("data.source.length + 3");
    expect(service).toContain("expectedVoucherIds.some");
    expect(service).toContain("sourceAudit = audit.find");
  });
  it("never individually deletes a linked voucher from either Daybook", () => {
    expect(daybook).toContain("daybook-voucher/");
    expect(daybook).toContain("/delete-linked");
    expect(daybook).toContain("confirmDeleteBothCompanies: true");
    expect(daybook).toContain("Cannot verify whether this voucher belongs to another company");
    expect(routes).toContain("daybookLinkedVoucherTrades([voucherId]");
    expect(routes).toContain("deletePristineLinkedTrade(trade.tradeId");
  });
  it("removes both linked PO sets and original vouchers in one atomic transaction", () => {
    expect(service).toContain("db.transaction(async (tx)");
    expect(service).toContain("tx.delete(purchaseOrders)");
    expect(service).toContain("tx.delete(vouchers)");
    expect(service).toContain("ic-technical-profit-normalized:");
    expect(service).toContain("IC_DELETE_NETTING_EVIDENCE");
    expect(service).toContain("tx.delete(intercompanyTradeSourcePos)");
    expect(service).toContain("tx.delete(intercompanyTrades)");
    expect(service).not.toContain("reverseVoucherTx");
    expect(service).not.toContain("postErpVoucherTx");
  });
  it("refuses deletion when payments, stock, revisions or charges exist", () => {
    for (const marker of [
      "requireUnreceived(data)",
      "allocations.length",
      "receipt.length",
      "revisions.length",
      "shared.length",
      "sharedPo.length",
      "activeSiblings.length !== 1",
      "IC_DELETE_VOUCHER_EVIDENCE",
    ])
      expect(service).toContain(marker);
  });
  it("qualifies canonical container columns inside linked-company subqueries", () => {
    const source = readFileSync("server/storage/containers-store/containers.ts", "utf8");
    const pagination = readFileSync("server/routes/containers/containerListPaginationRoutes.ts", "utf8");
    for (const text of [source, pagination]) {
      expect(text).toContain('trade.physical_container_id = "containers"."id"');
      expect(text).toContain('trade.source_company_id = "containers"."company_id"');
      expect(text).not.toContain("trade.physical_container_id = ${containers.id}");
      expect(text).not.toContain("trade.physical_container_id = ${schema.containers.id}");
    }
  });
  it("shows the physical linked container in both list endpoint families", () => {
    expect(storage).toContain("trade.destination_company_id");
    expect(storage).toContain("trade.source_company_id");
    expect(pagination).toContain("trade.destination_company_id");
    expect(pagination).toContain("trade.source_company_id");
    expect(storage).toContain("linkedParentCompanyName");
    expect(pagination).toContain("linkedParentCompanyName");
  });
});
