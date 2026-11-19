// Extracted from ./FactoryDispatchBatchDetail.tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Truck, Package, Scale, DollarSign, Eye, ScanLine, RotateCcw } from "lucide-react";
import { fmt } from "./factorydispatchbatchdetail/utils";
import { RideStatusBadge } from "./factorydispatchbatchdetail/components/RideStatusBadge";
import { BatchInfoCard } from "./factorydispatchbatchdetail/components/BatchInfoCard";
import { EmptyState } from "@/components/ui/page-state";
import type {
  FactoryDispatchBatchDetailModel,
  FactoryDispatchBatchDetailView,
} from "./FactoryDispatchBatchDetailModel";

export function FactoryDispatchBatchDetailBody({
  bd,
  view,
  batchId,
}: {
  bd: FactoryDispatchBatchDetailModel;
  view: FactoryDispatchBatchDetailView;
  batchId: NonNullable<FactoryDispatchBatchDetailModel["batchId"]>;
}) {
  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Truck className="w-4 h-4" />
              <span className="text-xs">Rides</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-total-rides">
              {view.rides.length}
            </p>
            <p className="text-xs text-muted-foreground">
              {view.rides.filter((r) => r.status === "DISPATCHED").length} dispatched
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Package className="w-4 h-4" />
              <span className="text-xs">Bales</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-total-bales">
              {fmt(view.totalBales, 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Scale className="w-4 h-4" />
              <span className="text-xs">Weight (kg)</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-total-weight">
              {fmt(view.totalWeight)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <DollarSign className="w-4 h-4" />
              <span className="text-xs">Total Value</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-total-value">
              {view.batch.currency} {fmt(view.totalValue)}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-1 space-y-3">
          <BatchInfoCard
            batch={view.batch}
            customerName={view.customerName}
            proforma={view.proforma}
            finalInvoice={view.finalInvoice}
          />

          {view.progress.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-1.5">
                  <Package className="w-4 h-4" /> Proforma Progress
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Article</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Target</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Scanned</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Rem.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.progress.map((p) => (
                        <tr
                          key={p.articleCode}
                          className="border-b last:border-0"
                          data-testid={`row-progress-${p.articleCode}`}
                        >
                          <td className="px-3 py-2 font-mono">{p.articleCode}</td>
                          <td className="px-3 py-2 text-right">{p.proformaQty}</td>
                          <td className="px-3 py-2 text-right">
                            <span className={p.scannedQty > p.proformaQty ? "text-amber-600 font-medium" : ""}>
                              {p.scannedQty}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <span
                              className={p.remaining < 0 ? "text-amber-600" : p.remaining === 0 ? "text-green-600" : ""}
                            >
                              {p.remaining}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="md:col-span-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Truck className="w-4 h-4" /> Truck Rides
                {view.canChangeBatch && (
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => bd.setAddRideOpen(true)}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {view.rides.length === 0 ? (
                <EmptyState
                  icon={Truck}
                  title="No truck rides yet"
                  className="border-0"
                  action={
                    view.canChangeBatch ? (
                      <Button size="sm" variant="outline" onClick={() => bd.setAddRideOpen(true)}>
                        <Plus className="w-4 h-4 mr-1" /> Add first ride
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <Table mobileLayout="cards">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Truck</TableHead>
                      <TableHead>Driver</TableHead>
                      <TableHead className="text-right">Bales</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.rides.map((ride) => (
                      <TableRow key={ride.id} data-testid={`row-ride-${ride.id}`}>
                        <TableCell className="font-mono text-muted-foreground">{ride.rideNumber}</TableCell>
                        <TableCell>{ride.truckPlate || <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell>{ride.driverName || <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-right">{fmt(ride.baleCount, 0)}</TableCell>
                        <TableCell className="text-right">{fmt(ride.totalWeightKg)}</TableCell>
                        <TableCell className="text-right">{fmt(ride.totalAmount)}</TableCell>
                        <TableCell>
                          <RideStatusBadge status={ride.status} />
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1.5 justify-end">
                            {(ride.status === "LOADING" || ride.status === "DRAFT") && view.canChangeBatch && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  bd.navigate(`/factory/dispatch-batches/${batchId}/rides/${ride.id}/scan`)
                                }
                                data-testid={`button-open-scanner-${ride.id}`}
                              >
                                <ScanLine className="w-3.5 h-3.5 mr-1" /> Scan
                              </Button>
                            )}
                            {ride.status === "DISPATCHED" && view.canChangeBatch && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  bd.setReopenRideId(ride.id);
                                  bd.setReopenReason("");
                                }}
                                data-testid={`button-reopen-ride-${ride.id}`}
                              >
                                <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reopen
                              </Button>
                            )}
                            {ride.status === "DISPATCHED" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  bd.navigate(`/factory/dispatch-batches/${batchId}/rides/${ride.id}/scan`)
                                }
                                data-testid={`button-view-scan-${ride.id}`}
                              >
                                <Eye className="w-3.5 h-3.5 mr-1" /> View
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
