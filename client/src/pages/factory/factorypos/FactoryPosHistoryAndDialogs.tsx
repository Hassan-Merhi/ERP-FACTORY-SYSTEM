/**
 * Sales history table and the two Factory POS dialogs (print prompt with the
 * hidden receipt, and the void confirmation).
 *
 * Split out of FactoryPOS.tsx unchanged: history rows still use each sale's
 * own currency prefix, and voided sales still hide the Void action.
 */
import { History, Printer } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNum } from "./utils";
import { FactoryPosPrintTemplate } from "./FactoryPosPrintTemplate";
import type { FactoryPosModel } from "./useFactoryPosModel";

export function FactoryPosHistory({ model }: { model: FactoryPosModel }) {
  if (!model.showHistory) return null;
  const { sales, salesLoading } = model;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4" />
          Sales History
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {salesLoading ? (
          <div className="p-6 text-center text-muted-foreground">Loading...</div>
        ) : !sales || sales.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground">No sales yet</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sale #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.map((sale) => {
                const pfx = sale.currencyCode !== "USD" ? `${sale.currencyCode} ` : "$";
                return (
                  <TableRow key={sale.id} data-testid={`row-sale-${sale.id}`}>
                    <TableCell className="font-mono text-sm">{sale.saleNumber}</TableCell>
                    <TableCell className="text-sm">{sale.txDate}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{sale.customerName || "—"}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {pfx}
                      {formatNum(sale.totalAmount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={sale.status === "VOIDED" ? "secondary" : "outline"}>{sale.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {sale.status !== "VOIDED" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-destructive"
                          onClick={() => model.setVoidId(sale.id)}
                          data-testid={`button-void-${sale.id}`}
                        >
                          Void
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function FactoryPosDialogs({ model }: { model: FactoryPosModel }) {
  return (
    <>
      {/* ── Print Dialog ── */}
      <AlertDialog open={model.showPrintDialog} onOpenChange={model.setShowPrintDialog}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Print Invoice</AlertDialogTitle>
            <AlertDialogDescription>Sale recorded successfully. Print the invoice?</AlertDialogDescription>
          </AlertDialogHeader>

          {/* Hidden Print Template */}
          <FactoryPosPrintTemplate
            printRef={model.printRef}
            savedSale={model.savedSale}
            printUserName={model.printUserName}
            fmtPrint={model.fmtPrint}
            fmtPrintAmt={model.fmtPrintAmt}
          />

          <AlertDialogFooter>
            <Button variant="outline" onClick={() => model.setShowPrintDialog(false)} data-testid="button-cancel-print">
              Close
            </Button>
            <Button onClick={model.handlePrint} className="gap-2" data-testid="button-print-invoice">
              <Printer className="h-4 w-4" />
              Print Invoice
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Void confirmation ── */}
      <AlertDialog open={model.voidId !== null} onOpenChange={() => model.setVoidId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void this sale?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the sale as voided and restore the bale inventory. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => model.setVoidId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => model.voidId !== null && model.voidMutation.mutate(model.voidId)}
              disabled={model.voidMutation.isPending}
            >
              {model.voidMutation.isPending ? "Voiding..." : "Void Sale"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
