import type { ClientErrorLike } from "@/lib/clientError";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { Plus, Truck, Package, Filter, ChevronRight, Search, BarChart2 } from "lucide-react";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { visibleTabInterval } from "@/lib/queryPolicies";

interface Customer {
  id: number;
  legalName: string;
}
interface ProformaLine {
  articleCode: string;
  productName: string;
  quantity: number;
  pricePerBale: string;
}
interface Proforma {
  id: number;
  name: string;
  customerId: number;
  isActive: boolean;
  lines?: ProformaLine[];
}

interface BatchRow {
  id: number;
  batchNumber: string;
  batchDate: string;
  status: string;
  currency: string;
  priceMode: string;
  destination: string | null;
  customerId: number;
  proformaId: number | null;
  customerName: string | null;
  proformaName: string | null;
  rideCount: number | string;
  baleCount: number | string;
  totalWeightKg: string;
  totalAmount: string;
  invoiceNumber: string | null;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  DRAFT: { label: "Draft", className: "bg-muted text-muted-foreground" },
  LOADING: { label: "Loading", className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  DISPATCHED: { label: "Dispatched", className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" },
  INVOICED: { label: "Invoiced", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  CANCELLED: { label: "Cancelled", className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, className: "" };
  return <Badge className={cfg.className}>{cfg.label}</Badge>;
}

function fmt(n: number | string) {
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "0";
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function FactoryDispatchBatches() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();

  const [filterCustomer, setFilterCustomer] = useState("_all");
  const [filterStatus, setFilterStatus] = useState("_all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"list" | "reports">("list");
  const searchStr = useSearch();

  const [form, setForm] = useState({
    customerId: "",
    proformaId: "_none",
    batchDate: new Date().toISOString().split("T")[0],
    currency: "USD",
    priceMode: "PER_BALE",
    destination: "",
    notes: "",
  });

  useEffect(() => {
    const params = new URLSearchParams(searchStr);
    if (params.get("openCreate") === "1") {
      const cid = params.get("customerId") || "";
      const pid = params.get("proformaId") || "_none";
      setForm((f) => ({ ...f, customerId: cid, proformaId: pid }));
      setCreateOpen(true);
    }
  }, [searchStr]);

  const qParams = new URLSearchParams();
  if (filterCustomer && filterCustomer !== "_all") qParams.set("customerId", filterCustomer);
  if (filterStatus && filterStatus !== "_all") qParams.set("status", filterStatus);

  const { data: me } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = me?.role === "Developer";

  const { data: batches = [], isLoading } = useQuery<BatchRow[]>({
    queryKey: [`/api/factory/dispatch-batches`, filterCustomer, filterStatus],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches?${qParams}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: visibleTabInterval(60_000),
    refetchIntervalInBackground: false,
  });

  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["/api/factory/customers"] });

  const { data: proformas = [] } = useQuery<Proforma[]>({
    queryKey: [`/api/factory/customer-proformas?customerId=${form.customerId}&profile=summary&pageSize=250`],
    queryFn: async () => {
      if (!form.customerId) return [];
      const res = await fetch(
        `/api/factory/customer-proformas?customerId=${form.customerId}&profile=summary&pageSize=250`,
        {
          credentials: "include",
        }
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!form.customerId && createOpen,
    staleTime: 5 * 60_000,
  });

  interface ReportsSummary {
    uninvoicedCount: number;
    dispatchedCount: number;
    invoicedCount: number;
    loadingCount: number;
    reservedBalesCount: number;
    dispatchedRidesNotInvoiced: number;
  }
  const { data: reportsSummary, isLoading: reportsLoading } = useQuery<ReportsSummary>({
    queryKey: ["/api/factory/dispatch-reports/summary"],
    queryFn: async () => {
      const res = await fetch("/api/factory/dispatch-reports/summary", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: activeTab === "reports",
    staleTime: 30_000,
    refetchInterval: activeTab === "reports" ? visibleTabInterval(60_000) : false,
    refetchIntervalInBackground: false,
  });

  const activeProformas = proformas.filter((p) => p.isActive);

  const selectedProforma = proformas.find((p) => p.id === parseInt(form.proformaId));

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload: {
        customerId: number;
        batchDate: string;
        currency: string;
        priceMode: string;
        destination: string | undefined;
        notes: string | undefined;
        proformaId?: number;
      } = {
        customerId: parseInt(form.customerId),
        batchDate: form.batchDate,
        currency: form.currency,
        priceMode: form.priceMode,
        destination: form.destination || undefined,
        notes: form.notes || undefined,
      } as {
        customerId: number;
        batchDate: string;
        currency: string;
        priceMode: string;
        destination: string | undefined;
        notes: string | undefined;
        proformaId?: number;
      };
      if (form.proformaId && form.proformaId !== "_none") payload.proformaId = parseInt(form.proformaId);
      const res = await apiRequest("POST", "/api/factory/dispatch-batches", payload);
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries(
        { queryKey: ["/api/factory/dispatch-batches"], refetchType: "active" },
        { cancelRefetch: false }
      );
      toast({ title: "Batch created", description: `Dispatch batch ${data.batch?.batchNumber} created.` });
      setCreateOpen(false);
      resetForm();
      if (data.batch?.id) navigate(`/factory/dispatch-batches/${data.batch.id}`);
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function resetForm() {
    setForm({
      customerId: "",
      proformaId: "_none",
      batchDate: new Date().toISOString().split("T")[0],
      currency: "USD",
      priceMode: "PER_BALE",
      destination: "",
      notes: "",
    });
  }

  const filtered = batches.filter((b) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      b.batchNumber.toLowerCase().includes(q) ||
      (b.customerName || "").toLowerCase().includes(q) ||
      (b.invoiceNumber || "").toLowerCase().includes(q)
    );
  });

  if (me && !isDeveloper) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Truck className="w-10 h-10 opacity-30" />
        <p className="text-sm">Dispatch Batches is only available in Developer mode.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Dispatch Batches" subtitle="Manage local truck dispatch batches for bale sales">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant={activeTab === "list" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("list")}
            data-testid="button-tab-list"
          >
            <Truck className="w-3.5 h-3.5 mr-1.5" />
            Batches
          </Button>
          {isDeveloper && (
            <Button
              variant={activeTab === "reports" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveTab("reports")}
              data-testid="button-tab-reports"
            >
              <BarChart2 className="w-3.5 h-3.5 mr-1.5" />
              Reports
            </Button>
          )}
          <Button onClick={() => setCreateOpen(true)} data-testid="button-new-dispatch-batch">
            <Plus className="w-4 h-4 mr-2" />
            New Dispatch Batch
          </Button>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* ── Reports tab ─────────────────────────────────────────────────────── */}
        {isDeveloper &&
          activeTab === "reports" &&
          (reportsLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : reportsSummary ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <Card
                  className="cursor-pointer hover-elevate"
                  onClick={() => {
                    setActiveTab("list");
                    setFilterStatus("");
                  }}
                  data-testid="card-report-uninvoiced"
                >
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground mb-1">Uninvoiced Batches</p>
                    <p className="text-3xl font-bold" data-testid="text-uninvoiced-count">
                      {reportsSummary.uninvoicedCount}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Draft + Loading + Dispatched</p>
                  </CardContent>
                </Card>
                <Card
                  className="cursor-pointer hover-elevate"
                  onClick={() => {
                    setActiveTab("list");
                    setFilterStatus("LOADING");
                  }}
                  data-testid="card-report-loading"
                >
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground mb-1">Loading</p>
                    <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">{reportsSummary.loadingCount}</p>
                    <p className="text-xs text-muted-foreground mt-1">Batches currently being loaded</p>
                  </CardContent>
                </Card>
                <Card
                  className="cursor-pointer hover-elevate"
                  onClick={() => {
                    setActiveTab("list");
                    setFilterStatus("DISPATCHED");
                  }}
                  data-testid="card-report-dispatched"
                >
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground mb-1">Dispatched — Pending Invoice</p>
                    <p className="text-3xl font-bold text-amber-600 dark:text-amber-400">
                      {reportsSummary.dispatchedCount}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Trucks dispatched, no invoice yet</p>
                  </CardContent>
                </Card>
                <Card
                  className="cursor-pointer hover-elevate"
                  onClick={() => {
                    setActiveTab("list");
                    setFilterStatus("INVOICED");
                  }}
                  data-testid="card-report-invoiced"
                >
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground mb-1">Invoiced Batches</p>
                    <p className="text-3xl font-bold text-green-600 dark:text-green-400">
                      {reportsSummary.invoicedCount}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Completed &amp; invoiced</p>
                  </CardContent>
                </Card>
                <Card data-testid="card-report-reserved-bales">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground mb-1">Reserved Bales</p>
                    <p className="text-3xl font-bold">{reportsSummary.reservedBalesCount}</p>
                    <p className="text-xs text-muted-foreground mt-1">Bales scanned, not yet invoiced</p>
                  </CardContent>
                </Card>
                <Card data-testid="card-report-dispatched-rides">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground mb-1">Dispatched Rides</p>
                    <p className="text-3xl font-bold">{reportsSummary.dispatchedRidesNotInvoiced}</p>
                    <p className="text-xs text-muted-foreground mt-1">Rides dispatched, batch not invoiced</p>
                  </CardContent>
                </Card>
              </div>
              <p className="text-xs text-muted-foreground">Click a card to filter the batch list.</p>
            </div>
          ) : null)}

        {activeTab === "list" && (
          <>
            <Card>
              <CardContent className="pt-4">
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Filters</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Customer</Label>
                    <Select value={filterCustomer} onValueChange={setFilterCustomer}>
                      <SelectTrigger className="w-48" data-testid="select-filter-customer">
                        <SelectValue placeholder="All customers" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_all">All customers</SelectItem>
                        {customers.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.legalName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Status</Label>
                    <Select value={filterStatus} onValueChange={setFilterStatus}>
                      <SelectTrigger className="w-36" data-testid="select-filter-status">
                        <SelectValue placeholder="All statuses" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_all">All statuses</SelectItem>
                        <SelectItem value="DRAFT">Draft</SelectItem>
                        <SelectItem value="LOADING">Loading</SelectItem>
                        <SelectItem value="DISPATCHED">Dispatched</SelectItem>
                        <SelectItem value="INVOICED">Invoiced</SelectItem>
                        <SelectItem value="CANCELLED">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Search</Label>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                      <Input
                        className="pl-8 w-52"
                        placeholder="Batch #, customer, invoice..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        data-testid="input-search-batches"
                      />
                    </div>
                  </div>
                  {(filterCustomer !== "_all" || filterStatus !== "_all" || search) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setFilterCustomer("_all");
                        setFilterStatus("_all");
                        setSearch("");
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-4 space-y-2">
                    {[...Array(5)].map((_, i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
                    <Truck className="w-10 h-10 opacity-40" />
                    <p className="text-sm">No dispatch batches found</p>
                    <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                      <Plus className="w-4 h-4 mr-1" /> Create first batch
                    </Button>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Batch #</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Proforma</TableHead>
                        <TableHead className="text-center">Rides</TableHead>
                        <TableHead className="text-right">Bales</TableHead>
                        <TableHead className="text-right">Weight (kg)</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Invoice</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((b) => (
                        <TableRow
                          key={b.id}
                          className="cursor-pointer hover-elevate"
                          onClick={() => navigate(`/factory/dispatch-batches/${b.id}`)}
                          data-testid={`row-dispatch-batch-${b.id}`}
                        >
                          <TableCell className="font-mono font-medium" data-testid={`text-batch-number-${b.id}`}>
                            {b.batchNumber}
                          </TableCell>
                          <TableCell data-testid={`text-batch-customer-${b.id}`}>{b.customerName || "—"}</TableCell>
                          <TableCell>{formatDisplayDate(b.batchDate)}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{b.proformaName || "—"}</TableCell>
                          <TableCell className="text-center">{b.rideCount}</TableCell>
                          <TableCell className="text-right">{fmt(b.baleCount)}</TableCell>
                          <TableCell className="text-right">{fmt(b.totalWeightKg)}</TableCell>
                          <TableCell className="text-right font-medium">
                            {b.currency} {fmt(b.totalAmount)}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={b.status} />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground font-mono">
                            {b.invoiceNumber || "—"}
                          </TableCell>
                          <TableCell>
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          if (!o) resetForm();
          setCreateOpen(o);
        }}
      >
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Dispatch Batch</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label>
                  Customer <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={form.customerId}
                  onValueChange={(v) => setForm((f) => ({ ...f, customerId: v, proformaId: "_none" }))}
                >
                  <SelectTrigger data-testid="select-create-customer">
                    <SelectValue placeholder="Select customer..." />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.legalName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {form.customerId && (
                <div className="col-span-2 space-y-1.5">
                  <Label>Proforma (optional)</Label>
                  <Select value={form.proformaId} onValueChange={(v) => setForm((f) => ({ ...f, proformaId: v }))}>
                    <SelectTrigger data-testid="select-create-proforma">
                      <SelectValue placeholder="No proforma" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No proforma</SelectItem>
                      {activeProformas.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {form.customerId && activeProformas.length === 0 && (
                    <p className="text-xs text-muted-foreground">No active proformas for this customer.</p>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label>
                  Batch Date <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="date"
                  value={form.batchDate}
                  onChange={(e) => setForm((f) => ({ ...f, batchDate: e.target.value }))}
                  data-testid="input-batch-date"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select value={form.currency} onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}>
                  <SelectTrigger data-testid="select-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="LBP">LBP</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label>Price Mode</Label>
                <Select value={form.priceMode} onValueChange={(v) => setForm((f) => ({ ...f, priceMode: v }))}>
                  <SelectTrigger data-testid="select-price-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PER_BALE">Per Bale (fixed price per bale)</SelectItem>
                    <SelectItem value="PER_KG">Per Kg (price × weight)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label>Destination</Label>
                <Input
                  placeholder="e.g. Lubumbashi Port"
                  value={form.destination}
                  onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))}
                  data-testid="input-destination"
                />
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label>Notes</Label>
                <Textarea
                  placeholder="Optional notes..."
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  data-testid="textarea-notes"
                />
              </div>
            </div>

            {selectedProforma && (
              <div className="border rounded-md p-3 space-y-2 bg-muted/40">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Package className="w-4 h-4" />
                  Proforma Summary — {selectedProforma.name}
                </p>
                {selectedProforma.lines && selectedProforma.lines.length > 0 ? (
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="text-left font-normal pb-1">Article</th>
                        <th className="text-left font-normal pb-1">Product</th>
                        <th className="text-right font-normal pb-1">Qty</th>
                        <th className="text-right font-normal pb-1">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedProforma.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="font-mono">{l.articleCode}</td>
                          <td className="text-muted-foreground">{l.productName}</td>
                          <td className="text-right">{l.quantity}</td>
                          <td className="text-right">{l.pricePerBale}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-xs text-muted-foreground">Loading proforma lines...</p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!form.customerId || !form.batchDate || createMutation.isPending}
              data-testid="button-create-batch-submit"
            >
              {createMutation.isPending ? "Creating..." : "Create Batch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
