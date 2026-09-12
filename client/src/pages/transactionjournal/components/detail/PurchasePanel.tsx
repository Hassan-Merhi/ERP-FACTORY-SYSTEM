/**
 * Purchase body of the All Daybook voucher detail dialog: the PO header with
 * its cross-company navigation buttons, the line-item table with charges and
 * discount, and the accounts table.
 *
 * Split out of TransactionJournal.tsx unchanged — the same charge list, the
 * same grand-total arithmetic (items + charges − discount) and the same
 * company-switching navigation targets.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { JournalPurchaseOrder, JournalViewEntry } from "../../types";
import type { DetailPanelFormatters } from "./panelTypes";

export function PurchasePanel({
  po,
  companyId,
  viewEntries,
  viewPurchaseItems,
  entryBalances,
  openInCompany,
  fmt,
  fmtNum,
}: {
  po: JournalPurchaseOrder;
  companyId: number;
  viewEntries: JournalViewEntry[];
  viewPurchaseItems: JournalViewEntry[];
  entryBalances: Record<number, string>;
  openInCompany: (companyId: number, path: string) => void;
} & DetailPanelFormatters) {
  const itemsTotal = viewPurchaseItems.reduce((s, r) => s + parseFloat(r.totalAmount || "0"), 0);
  const charges = [
    { label: "Freight", value: po.freight },
    { label: "Fumigation", value: po.fumigation },
    { label: "Surcharge", value: po.surcharge },
    { label: "Document Charges", value: po.documentCharges },
    { label: "Other Charges", value: po.otherCharges },
  ].filter((c) => c.value && parseFloat(c.value) !== 0);
  const discount = parseFloat(po.discount || "0");
  const chargesTotal = charges.reduce((s, c) => s + parseFloat(c.value || "0"), 0);
  const grandTotal = itemsTotal + chargesTotal - discount;

  return (
    <div className="space-y-4">
      {/* PO header */}
      <div className="p-3 md:p-4 bg-muted/50 rounded-md space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div>
            <span className="text-xs text-muted-foreground">PO Number: </span>
            <span className="font-semibold">{po.poNumber}</span>
          </div>
          {po.status && <Badge variant="outline">{po.status}</Badge>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {po.supplierName && (
            <div>
              <span className="text-muted-foreground">Supplier: </span>
              <span className="font-medium">{po.supplierName}</span>
            </div>
          )}
          {po.containerNumber && (
            <div>
              <span className="text-muted-foreground">Container: </span>
              <span className="font-medium">{po.containerNumber}</span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {po.containerId && (
            <Button
              size="sm"
              onClick={() => openInCompany(companyId, `/containers/${po.containerId}`)}
              data-testid="button-open-po"
            >
              Open
            </Button>
          )}
          {po.containerId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                openInCompany(
                  companyId,
                  `/containers/${po.containerId}/verification?autoCompare=true&supplierId=${po.supplierId}`
                )
              }
              data-testid="button-compare-po"
            >
              Compare
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => openInCompany(companyId, `/purchase-orders/${po.id}/edit`)}
            data-testid="button-edit-po"
          >
            Edit PO
          </Button>
        </div>
      </div>

      {viewPurchaseItems.length > 0 && (
        <div>
          <h3 className="font-semibold mb-3">Line Items</h3>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewPurchaseItems.map((r) => (
                  <TableRow key={r.id} data-testid={`row-po-item-${r.id}`}>
                    <TableCell className="font-medium">{r.accountName}</TableCell>
                    <TableCell className="text-right font-mono">{fmtNum(r.quantity)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(r.rate)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(r.totalAmount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/30">
                  <TableCell colSpan={3} className="text-right font-medium">
                    Items Subtotal
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold">{fmt(itemsTotal)}</TableCell>
                </TableRow>
                {charges.map((c) => (
                  <TableRow key={c.label}>
                    <TableCell colSpan={3} className="text-right text-muted-foreground">
                      {c.label}
                    </TableCell>
                    <TableCell className="text-right font-mono">{fmt(c.value)}</TableCell>
                  </TableRow>
                ))}
                {discount > 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-right text-muted-foreground">
                      Discount
                    </TableCell>
                    <TableCell className="text-right font-mono text-red-600 dark:text-red-400">
                      - {fmt(discount)}
                    </TableCell>
                  </TableRow>
                )}
                <TableRow className="font-bold bg-muted/50">
                  <TableCell colSpan={3} className="text-right">
                    Grand Total
                  </TableCell>
                  <TableCell className="text-right font-mono">{fmt(grandTotal)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {viewEntries.length > 0 && (
        <div>
          <h3 className="font-semibold mb-3">Accounts</h3>
          <div className="border rounded-md">
            <Table>
              <TableBody>
                {viewEntries.map((e) => {
                  const amount = Math.max(parseFloat(e.debitAmount || "0"), parseFloat(e.creditAmount || "0"));
                  return (
                    <TableRow key={e.id}>
                      <TableCell>
                        <div className="font-medium">{e.accountName}</div>
                        {entryBalances[e.id] !== undefined && (
                          <div className="text-xs text-muted-foreground">Balance: {fmt(entryBalances[e.id])}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{fmt(amount)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Default body: a plain account/amount ledger listing with a total row. */
export function LedgerEntriesPanel({
  entries,
  entryBalances,
  fmt,
}: {
  entries: JournalViewEntry[];
  entryBalances: Record<number, string>;
} & Pick<DetailPanelFormatters, "fmt">) {
  const grandTotal = entries.reduce(
    (s, e) => s + Math.max(parseFloat(e.debitAmount || "0"), parseFloat(e.creditAmount || "0")),
    0
  );
  return (
    <div>
      <p className="text-sm font-medium mb-2">Entries</p>
      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="text-right w-32">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => {
              const amount = Math.max(parseFloat(e.debitAmount || "0"), parseFloat(e.creditAmount || "0"));
              const bal = entryBalances[e.id];
              return (
                <TableRow key={e.id} data-testid={`row-entry-${e.id}`}>
                  <TableCell className="py-2">
                    <p className="text-sm font-medium">{e.accountName || `Account #${e.ledgerAccountId}`}</p>
                    {bal !== undefined && (
                      <p className="text-xs text-muted-foreground">Balance: {fmt(parseFloat(bal))}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono py-2">{fmt(amount)}</TableCell>
                </TableRow>
              );
            })}
            {entries.length > 0 && (
              <TableRow className="border-t font-semibold bg-muted/20">
                <TableCell className="py-2 text-sm">Total</TableCell>
                <TableCell className="text-right text-sm font-mono py-2">{fmt(grandTotal)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
