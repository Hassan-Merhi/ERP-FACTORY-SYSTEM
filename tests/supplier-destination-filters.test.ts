import { describe, expect, it } from "vitest";
import {
  computeLedgerKpis,
  enrichPurchaseOrderTotals,
  filterLedgerRowsByDate,
  filterPurchaseOrdersByDate,
  matchesSupplierDestination,
  purchaseOrderGrandTotal,
  supplierLedgerToExportRows,
} from "../client/src/pages/suppliers/ledgerSummaries";
import type { SupplierLedgerRow, SupplierPurchaseOrder } from "../client/src/pages/suppliers/supplierDisplay";

const po = (id: number, destinationCompanyId: number, importDate: string): SupplierPurchaseOrder => ({
  id,
  companyId: 1,
  companyName: "Parent",
  destinationCompanyId,
  destinationCompanyName: destinationCompanyId === 2 ? "Kinshasa" : "Mali",
  containerId: 100 + id,
  containerNumber: "TEST0000001",
  importDate,
  createdAt: importDate,
  itemsTotal: "100",
  freight: "15",
  surcharge: "5",
  fumigation: "0",
  documentCharges: "0",
  otherCharges: "0",
  discount: "0",
});

const txn = (id: number, destinationCompanyId: number | null): SupplierLedgerRow => ({
  type: "voucher",
  date: new Date().toISOString(),
  companyId: 1,
  companyName: "Parent",
  destinationCompanyId,
  destinationCompanyName: destinationCompanyId === 2 ? "Kinshasa" : destinationCompanyId === 3 ? "Mali" : null,
  docNumber: `V-${id}`,
  voucherId: id,
  description: "",
  voucherType: "Purchase",
  debit: id === 3 ? 25 : 0,
  credit: id === 1 ? 120 : id === 2 ? 220 : 0,
  balance: 0,
});

describe("supplier destination reporting", () => {
  it("filters by actual destination, not the source/posting company", () => {
    const orders = [po(1, 2, new Date().toISOString()), po(2, 3, new Date().toISOString())];
    const kinshasa = enrichPurchaseOrderTotals(
      orders.filter((order) => matchesSupplierDestination(order.destinationCompanyId, "2"))
    );
    expect(kinshasa).toHaveLength(1);
    expect(kinshasa[0].companyId).toBe(1);
    expect(kinshasa[0].destinationCompanyId).toBe(2);
    expect(purchaseOrderGrandTotal(kinshasa)).toBe(120);
    expect(purchaseOrderGrandTotal(enrichPurchaseOrderTotals(orders))).toBe(240);
  });

  it("keeps unmapped transactions separate rather than inventing a destination", () => {
    const rows = [txn(1, 2), txn(2, 3), txn(3, null)];
    expect(rows.filter((row) => matchesSupplierDestination(row.destinationCompanyId, "2"))).toHaveLength(1);
    expect(rows.filter((row) => matchesSupplierDestination(row.destinationCompanyId, "unassigned"))).toHaveLength(1);
    expect(rows.filter((row) => matchesSupplierDestination(row.destinationCompanyId, "all"))).toHaveLength(3);
    expect(rows.filter((row) => matchesSupplierDestination(row.destinationCompanyId, "bogus"))).toHaveLength(0);
    const selected = rows.filter((row) => matchesSupplierDestination(row.destinationCompanyId, "2"));
    expect(computeLedgerKpis(selected).txCount).toBe(1);
    expect(computeLedgerKpis(selected).totalPurchases).toBe(120);
  });

  it("uses the same date scope for PO and transaction totals", () => {
    const today = new Date().toISOString();
    const older = "2022-01-10T12:00:00Z";
    expect(filterPurchaseOrdersByDate([po(1, 2, today), po(2, 3, older)], "this_year")).toHaveLength(1);
    expect(filterLedgerRowsByDate([txn(1, 2), { ...txn(2, 3), date: older }], "this_year")).toHaveLength(1);
  });

  it("exports each transaction's destination company", () => {
    const rows = supplierLedgerToExportRows([txn(1, 2), txn(3, null)]);
    expect(rows[0].Destination).toBe("Kinshasa");
    expect(rows[1].Destination).toBe("Unassigned");
  });
});
