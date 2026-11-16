// Extracted from ./FactoryStockAllocationV3.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle, ChevronRight, Container, Package, Play, Plus, ScanLine, XCircle } from "lucide-react";
import { fmtDate, fmtDateTime, fmtKg } from "./factorystockallocationv3/utils";
import { StatusBadge } from "./factorystockallocationv3/components/StatusBadge";
import { useFactoryStockAllocationV3State } from "./useFactoryStockAllocationV3State";

export function FactoryStockAllocationV3Section({
  activeTab,
  expectedLoads,
  finalizedLoads,
  loadingLoads,
  proformas,
  setCancelTargetId,
  setCreateLoadProforma,
  setScanningLoad,
  startMutation,
  stockLoading,
  stockRows,
}: Pick<
  ReturnType<typeof useFactoryStockAllocationV3State>,
  | "activeTab"
  | "expectedLoads"
  | "finalizedLoads"
  | "loadingLoads"
  | "proformas"
  | "setCancelTargetId"
  | "setCreateLoadProforma"
  | "setScanningLoad"
  | "startMutation"
  | "stockLoading"
  | "stockRows"
>) {
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      {/* ── Stock Overview ── */}
      {activeTab === "overview" && (
        <div>
          <p className="text-sm text-muted-foreground mb-3">
            Per-article breakdown. FTP = Stock in Hand − Expected to Load − Loading.
          </p>
          {stockLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {!stockLoading && stockRows.length === 0 && (
            <p className="text-sm text-muted-foreground">No stock data available.</p>
          )}
          {stockRows.length > 0 && (
            <div className="rounded-md border table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="pl-4">Product</TableHead>
                    <TableHead className="text-right">Stock in Hand</TableHead>
                    <TableHead className="text-right">Expected to Load</TableHead>
                    <TableHead className="text-right">Loading</TableHead>
                    <TableHead className="text-right pr-4">Free to Promise</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stockRows.map((r) => (
                    <TableRow key={r.articleCode} data-testid={`row-v3-stock-${r.articleCode}`}>
                      <TableCell className="pl-4 py-2">
                        <p className="text-sm font-medium">{r.productName}</p>
                        <p className="text-xs text-muted-foreground font-mono">{r.articleCode}</p>
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <p className="text-sm font-semibold">{r.inStockBales}</p>
                        <p className="text-xs text-muted-foreground">{fmtKg(r.inStockKg)}</p>
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <p className="text-sm font-semibold text-blue-600 dark:text-blue-400">
                          {r.expectedToLoadBales}
                        </p>
                        <p className="text-xs text-muted-foreground">{fmtKg(r.expectedToLoadKg)}</p>
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <p className="text-sm font-semibold text-orange-600 dark:text-orange-400">{r.loadingBales}</p>
                        <p className="text-xs text-muted-foreground">{fmtKg(r.loadingKg)}</p>
                      </TableCell>
                      <TableCell className="text-right pr-4 py-2">
                        <p
                          className={`text-sm font-semibold ${r.ftpBales < 0 ? "text-red-500" : "text-green-600 dark:text-green-400"}`}
                        >
                          {r.ftpBales}
                        </p>
                        <p className="text-xs text-muted-foreground">{fmtKg(r.ftpKg)}</p>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* ── Expected to Load ── */}
      {activeTab === "expected" && (
        <div>
          {expectedLoads.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Container className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No loads in Expected to Load.</p>
              <p className="text-xs mt-1">Go to Proformas tab to create one.</p>
            </div>
          )}
          {expectedLoads.length > 0 && (
            <div className="rounded-md border table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="pl-4">Load Name</TableHead>
                    <TableHead>Proforma</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Expected Date</TableHead>
                    <TableHead className="text-right">Bales</TableHead>
                    <TableHead className="pr-4">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expectedLoads.map((l) => (
                    <TableRow key={l.id} data-testid={`row-v3-expected-${l.id}`}>
                      <TableCell className="pl-4 py-2">
                        <p className="text-sm font-medium">{l.loadName}</p>
                        <p className="text-xs text-muted-foreground">{l.createdByName ?? "—"}</p>
                      </TableCell>
                      <TableCell className="py-2 text-sm">{l.proformaName}</TableCell>
                      <TableCell className="py-2 text-sm">{l.customerName}</TableCell>
                      <TableCell className="py-2 text-sm">{fmtDate(l.expectedLoadDate)}</TableCell>
                      <TableCell className="text-right py-2 text-sm">{l.totalBales}</TableCell>
                      <TableCell className="pr-4 py-2">
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            onClick={() => startMutation.mutate(l.id)}
                            disabled={startMutation.isPending}
                            data-testid={`button-v3-start-${l.id}`}
                          >
                            <Play className="h-3 w-3 mr-1" />
                            Start Loading
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setCancelTargetId(l.id)}
                            data-testid={`button-v3-cancel-${l.id}`}
                          >
                            <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* ── Loading ── */}
      {activeTab === "loading" && (
        <div>
          {loadingLoads.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <ScanLine className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No loads currently being loaded.</p>
            </div>
          )}
          {loadingLoads.length > 0 && (
            <div className="space-y-3">
              {loadingLoads.map((l) => (
                <Card key={l.id} data-testid={`card-v3-loading-${l.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-semibold">{l.loadName}</span>
                          <StatusBadge status={l.status} />
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {l.proformaName} · {l.customerName}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">Started: {fmtDateTime(l.startedAt)}</p>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Scanned</p>
                          <p className="text-lg font-bold text-green-600 dark:text-green-400">{l.scannedBales}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Total Bales</p>
                          <p className="text-lg font-bold">{l.totalBales}</p>
                        </div>
                        <Button size="sm" onClick={() => setScanningLoad(l)} data-testid={`button-v3-continue-${l.id}`}>
                          <ChevronRight className="h-3.5 w-3.5 mr-1" />
                          Continue
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Finalized ── */}
      {activeTab === "finalized" && (
        <div>
          {finalizedLoads.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <CheckCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No finalized loads yet.</p>
            </div>
          )}
          {finalizedLoads.length > 0 && (
            <div className="rounded-md border table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="pl-4">Load Name</TableHead>
                    <TableHead>Proforma</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Finalized At</TableHead>
                    <TableHead className="text-right">Bales</TableHead>
                    <TableHead className="text-right pr-4">Weight</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {finalizedLoads.map((l) => (
                    <TableRow key={l.id} data-testid={`row-v3-finalized-${l.id}`}>
                      <TableCell className="pl-4 py-2">
                        <p className="text-sm font-medium">{l.loadName}</p>
                        <p className="text-xs text-muted-foreground">{l.finalizedByName ?? "—"}</p>
                      </TableCell>
                      <TableCell className="py-2 text-sm">{l.proformaName}</TableCell>
                      <TableCell className="py-2 text-sm">{l.customerName}</TableCell>
                      <TableCell className="py-2 text-sm">{fmtDateTime(l.finalizedAt)}</TableCell>
                      <TableCell className="text-right py-2 text-sm font-semibold">{l.scannedBales}</TableCell>
                      <TableCell className="text-right pr-4 py-2 text-sm text-muted-foreground">
                        {fmtKg(l.scannedWeightKg)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* ── Proformas ── */}
      {activeTab === "proformas" && (
        <div>
          <p className="text-sm text-muted-foreground mb-3">
            Active proformas. Click "Send to Expected to Load" to create a loading job.
          </p>
          {proformas.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Package className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No active proformas found.</p>
            </div>
          )}
          {proformas.length > 0 && (
            <div className="rounded-md border table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="pl-4">Proforma</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead className="text-right">Total Qty</TableHead>
                    <TableHead>V3 Loads</TableHead>
                    <TableHead className="pr-4">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {proformas.map((p) => (
                    <TableRow key={p.id} data-testid={`row-v3-proforma-${p.id}`}>
                      <TableCell className="pl-4 py-2">
                        <p className="text-sm font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{fmtDate(p.createdAt)}</p>
                      </TableCell>
                      <TableCell className="py-2 text-sm">{p.customerName}</TableCell>
                      <TableCell className="text-right py-2 text-sm">{p.lineCount}</TableCell>
                      <TableCell className="text-right py-2 text-sm">{p.totalQty}</TableCell>
                      <TableCell className="py-2">
                        {p.v3LoadCount > 0 ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm">{p.v3LoadCount}</span>
                            {p.v3ActiveCount > 0 && (
                              <span className="text-xs text-orange-600 dark:text-orange-400">
                                ({p.v3ActiveCount} active)
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 py-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setCreateLoadProforma(p)}
                          data-testid={`button-v3-send-etl-${p.id}`}
                        >
                          <Plus className="h-3 w-3 mr-1" />
                          Send to ETL
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
