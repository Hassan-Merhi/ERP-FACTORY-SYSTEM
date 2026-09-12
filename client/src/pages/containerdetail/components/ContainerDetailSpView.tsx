import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Package } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SpOffloadDialog } from "@/components/SpOffloadDialog";
import { queryClient } from "@/lib/queryClient";
import type { useContainerDetailModel } from "../useContainerDetailModel";

type Model = ReturnType<typeof useContainerDetailModel>;
export function ContainerDetailSpView({ model }: { model: Model }) {
  const { containerId, spContainerData, spDetailLoading, showSpOffloadDialog, setShowSpOffloadDialog } = model;
  const spFmt = (v: number | string | null | undefined) => {
    const n = parseFloat(String(v ?? "0"));
    const isWhole = Math.abs(n) % 1 === 0;
    return isNaN(n)
      ? "$0"
      : `$${n.toLocaleString("en-US", { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };

  if (spDetailLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  // The server signals a missing container with a `{ message }` error body.
  if (!spContainerData || "message" in spContainerData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Package className="w-16 h-16 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">Container not found</h2>
        <Link href="/containers">
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Containers
          </Button>
        </Link>
      </div>
    );
  }

  const spc = spContainerData;
  const discFactor = 1 - parseFloat(spc.discountPct || "0") / 100;
  const baseCost = (spc.lines || []).reduce(
    (s: number, l) => s + parseFloat(l.qty || "0") * parseFloat(l.unitRateUsd || "0") * discFactor,
    0
  );

  return (
    <div className="space-y-4 sm:space-y-6" data-testid="sp-container-detail">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap">
        <Link href="/containers">
          <Button variant="ghost" size="icon" data-testid="button-sp-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold truncate">
            {spc.invoiceNumber || spc.containerNumber || `Container #${spc.id}`}
          </h1>
          <p className="text-sm text-muted-foreground">{spc.supplierName}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {spc.status === "offloaded" ? (
            <Badge variant="outline" className="text-green-600 border-green-600/40">
              Offloaded
            </Badge>
          ) : (
            <Badge variant="outline" className="text-blue-600 border-blue-600/40">
              Open / OTW
            </Badge>
          )}
          {spc.status !== "offloaded" && (
            <Button onClick={() => setShowSpOffloadDialog(true)} data-testid="button-sp-offload">
              <Package className="h-4 w-4 mr-2" />
              Offload
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Invoice Total</p>
            <p className="font-semibold text-lg tabular-nums">{spFmt(spc.invoiceTotalUsd)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Discount</p>
            <p className="font-semibold text-lg">{spc.discountPct || "0"}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Base Cost (discounted)</p>
            <p className="font-semibold text-lg tabular-nums">{spFmt(baseCost)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Invoice Date</p>
            <p className="font-semibold text-lg">{spc.invoiceDate}</p>
          </CardContent>
        </Card>
      </div>

      {/* Line Items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Article Code</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Rate (USD)</TableHead>
                <TableHead className="text-right">Disc. Rate</TableHead>
                <TableHead className="text-right">Line Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(spc.lines || []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                    No line items
                  </TableCell>
                </TableRow>
              ) : (
                (spc.lines || []).map((line) => {
                  const discRate = parseFloat(line.unitRateUsd || "0") * discFactor;
                  const lineCost = parseFloat(line.qty || "0") * discRate;
                  return (
                    <TableRow key={line.id} data-testid={`row-sp-line-${line.id}`}>
                      <TableCell className="font-mono text-sm">{line.articleCode}</TableCell>
                      <TableCell className="text-sm">{line.description || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {parseFloat(line.qty).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {spFmt(line.unitRateUsd)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{spFmt(discRate)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{spFmt(lineCost)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Prepaid Charges */}
      {(spc.prepaid || []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prepaid Charges</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount (USD)</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(spc.prepaid || []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-sm capitalize">{p.chargeType}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{p.notes || p.agentName || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{spFmt(p.amountPaidUsd)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{p.prepaidDate}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Offload Summary */}
      {spc.status === "offloaded" && spc.offload && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Offload Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <p className="text-xs text-muted-foreground">Offload Date</p>
              <p className="font-medium">{spc.offload.offloadDate}</p>
            </div>
            {(spc.offloadCharges || []).length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Amount (USD)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(spc.offloadCharges || []).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="text-sm capitalize">{c.chargeType}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.description || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{spFmt(c.amountUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Notes */}
      {spc.notes && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground mb-1">Notes</p>
            <p className="text-sm">{spc.notes}</p>
          </CardContent>
        </Card>
      )}

      <SpOffloadDialog
        open={showSpOffloadDialog}
        onOpenChange={setShowSpOffloadDialog}
        container={spc}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: [`/api/sp/containers/${containerId}`] })}
      />
    </div>
  );
}
