// Extracted from ./FactoryWorkerBonusesTab.tsx
import { Trash2, Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { today, useFactoryWorkerBonusesTabState } from "./useFactoryWorkerBonusesTabState";

export function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function FactoryWorkerBonusesTabContent({
  bonuses,
  recordChanges,
  setDeleteConfirm,
  setPayForm,
  setPayOpen,
}: Pick<
  ReturnType<typeof useFactoryWorkerBonusesTabState>,
  "bonuses" | "recordChanges" | "setDeleteConfirm" | "setPayForm" | "setPayOpen"
>) {
  return (
    <>
      <div className="hidden sm:block rounded-md border">
        <Table mobileLayout="cards">
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead>Worker</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {bonuses.map((b) => (
              <TableRow
                key={`${b.source ?? "worker"}-${b.id}`}
                data-testid={`row-worker-bonus-${b.source ?? "worker"}-${b.id}`}
              >
                <TableCell className="font-medium">{b.workerName}</TableCell>
                <TableCell className="text-sm">{b.bonusDate}</TableCell>
                <TableCell className="text-right font-mono">{fmt(b.amount)}</TableCell>
                <TableCell>
                  <Badge variant={b.status === "paid" ? "outline" : "secondary"}>
                    {b.status === "paid" ? "Paid" : b.status === "reversed" ? "Reversed" : "Pending"}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-32 truncate">
                  {b.notes || "—"}
                  {b.voucherId ? ` · Voucher #${b.voucherId}` : ""}
                </TableCell>
                <TableCell>
                  {recordChanges.allowed && (
                    <div className="flex gap-1 justify-end">
                      {b.status === "pending" && (!b.source || b.source === "worker") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setPayOpen(b);
                            setPayForm({ cashAccountId: "", paidDate: today() });
                          }}
                          data-testid={`button-pay-bonus-${b.id}`}
                        >
                          <Banknote className="h-3 w-3 mr-1" /> Pay
                        </Button>
                      )}
                      {(!b.source || b.source === "worker") && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteConfirm(b)}
                          data-testid={`button-delete-worker-bonus-${b.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="sm:hidden space-y-2">
        {bonuses.map((b) => (
          <Card
            key={`${b.source ?? "worker"}-${b.id}`}
            data-testid={`card-worker-bonus-${b.source ?? "worker"}-${b.id}`}
          >
            <CardContent className="p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-sm">{b.workerName}</p>
                  <p className="text-xs text-muted-foreground">{b.bonusDate}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-sm font-medium">{fmt(b.amount)}</span>
                  <Badge variant={b.status === "paid" ? "outline" : "secondary"}>
                    {b.status === "paid" ? "Paid" : b.status === "reversed" ? "Reversed" : "Pending"}
                  </Badge>
                </div>
              </div>
              {b.notes && <p className="text-xs text-muted-foreground">{b.notes}</p>}
              {recordChanges.allowed && (
                <div className="flex gap-2 pt-1">
                  {b.status === "pending" && (!b.source || b.source === "worker") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => {
                        setPayOpen(b);
                        setPayForm({ cashAccountId: "", paidDate: today() });
                      }}
                    >
                      <Banknote className="h-3 w-3 mr-1" /> Mark Paid
                    </Button>
                  )}
                  {(!b.source || b.source === "worker") && (
                    <Button size="icon" variant="ghost" onClick={() => setDeleteConfirm(b)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
