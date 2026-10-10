import type { ClientErrorLike } from "@/lib/clientError";
// LEGACY — Stock Allocation V3. Superseded by FactoryStockAllocationV5. Kept as fallback only. Route: /factory/stock-allocation-v3 (not in sidebar).
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Package, ScanLine, Play, CheckCircle, XCircle, Plus, Container, ChevronRight } from "lucide-react";

import type { Proforma, StockRow, Tab, V3Load } from "./factorystockallocationv3/types";
import { TABS, TAB_LABELS, fmtDate, fmtDateTime, fmtKg } from "./factorystockallocationv3/utils";
import { StatusBadge } from "./factorystockallocationv3/components/StatusBadge";
import { ScanningPanel } from "./factorystockallocationv3/components/ScanningPanel";
import { CreateLoadDialog } from "./factorystockallocationv3/components/CreateLoadDialog";
// ─────────────────────── Types ───────────────────────

export default function FactoryStockAllocationV3() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [scanningLoad, setScanningLoad] = useState<V3Load | null>(null);
  const [createLoadProforma, setCreateLoadProforma] = useState<Proforma | null>(null);
  const [cancelTargetId, setCancelTargetId] = useState<number | null>(null);

  // Queries
  const { data: stockRows = [], isLoading: stockLoading } = useQuery<StockRow[]>({
    queryKey: ["/api/factory/v3/stock-overview"],
  });

  const { data: expectedLoads = [] } = useQuery<V3Load[]>({
    queryKey: ["/api/factory/v3/loads", "expected_to_load"],
    queryFn: () =>
      fetch("/api/factory/v3/loads?status=expected_to_load", { credentials: "include" }).then((r) => r.json()),
  });

  const { data: loadingLoads = [] } = useQuery<V3Load[]>({
    queryKey: ["/api/factory/v3/loads", "loading"],
    queryFn: () => fetch("/api/factory/v3/loads?status=loading", { credentials: "include" }).then((r) => r.json()),
  });

  const { data: finalizedLoads = [] } = useQuery<V3Load[]>({
    queryKey: ["/api/factory/v3/loads", "finalized"],
    queryFn: () => fetch("/api/factory/v3/loads?status=finalized", { credentials: "include" }).then((r) => r.json()),
  });

  const { data: proformas = [] } = useQuery<Proforma[]>({
    queryKey: ["/api/factory/v3/proformas"],
  });

  // KPI totals
  const totalInStock = stockRows.reduce((s, r) => s + (r.inStockBales ?? 0), 0);
  const totalEtl = stockRows.reduce((s, r) => s + (r.expectedToLoadBales ?? 0), 0);
  const totalLoading = stockRows.reduce((s, r) => s + (r.loadingBales ?? 0), 0);
  const totalFtp = stockRows.reduce((s, r) => s + (r.ftpBales ?? 0), 0);

  const startMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/factory/v3/loads/${id}/start`, { method: "PATCH", credentials: "include" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: (_, _id) => {
      toast({ title: "Loading started" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/stock-overview"] });
      setActiveTab("loading");
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/factory/v3/loads/${id}/cancel`, { method: "PATCH", credentials: "include" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Load cancelled" });
      setCancelTargetId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/stock-overview"] });
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // If scanning panel is open, show it full-screen
  if (scanningLoad) {
    return (
      <div className="h-full flex flex-col bg-background">
        <ScanningPanel load={scanningLoad} onClose={() => setScanningLoad(null)} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Page header */}
      <div className="px-6 pt-5 pb-3 border-b shrink-0">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <PageHeader title="Stock Allocation" />
          <Badge className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-sm">v3.0 TEST</Badge>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            Factory 2.0 isolated module — not production
          </span>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Stock in Hand</p>
              <p className="text-2xl font-bold">{totalInStock}</p>
              <p className="text-xs text-muted-foreground">bales</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-blue-600 dark:text-blue-400">Expected to Load</p>
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{totalEtl}</p>
              <p className="text-xs text-muted-foreground">bales reserved</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-orange-600 dark:text-orange-400">Loading</p>
              <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">{totalLoading}</p>
              <p className="text-xs text-muted-foreground">bales in progress</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-green-600 dark:text-green-400">Free to Promise</p>
              <p
                className={`text-2xl font-bold ${totalFtp < 0 ? "text-red-500" : "text-green-600 dark:text-green-400"}`}
              >
                {totalFtp}
              </p>
              <p className="text-xs text-muted-foreground">bales available</p>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 flex-wrap">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              data-testid={`button-v3-tab-${tab}`}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                activeTab === tab
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent/40"
              }`}
            >
              {TAB_LABELS[tab]}
              {tab === "expected" && expectedLoads.length > 0 && (
                <span className="ml-1.5 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-sm px-1">
                  {expectedLoads.length}
                </span>
              )}
              {tab === "loading" && loadingLoads.length > 0 && (
                <span className="ml-1.5 text-xs bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 rounded-sm px-1">
                  {loadingLoads.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab body */}
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
                          <Button
                            size="sm"
                            onClick={() => setScanningLoad(l)}
                            data-testid={`button-v3-continue-${l.id}`}
                          >
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

      {/* Cancel confirmation */}
      <AlertDialog
        open={cancelTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTargetId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this load?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the expected load. Free to Promise will be restored. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => cancelTargetId && cancelMutation.mutate(cancelTargetId)}>
              Cancel Load
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Load dialog */}
      <CreateLoadDialog
        proforma={createLoadProforma}
        open={!!createLoadProforma}
        onClose={() => setCreateLoadProforma(null)}
      />
    </div>
  );
}
