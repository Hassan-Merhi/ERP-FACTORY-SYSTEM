import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, BarChart3, FileSpreadsheet } from "lucide-react";
import { QuickMonthlyClose } from "./golden-coast/QuickMonthlyClose";

const REPORT_TABS = ["profit", "sales-form"] as const;
type ReportTab = (typeof REPORT_TABS)[number];

type CashAccount = {
  id: string | number;
  name: string;
};

type AccountsResponse = {
  accounts?: CashAccount[];
};

interface SpProfitReport {
  saleCount?: number;
  totalRevenue?: number;
  totalCogs?: number;
  grossProfit?: number;
  totalSharedCharges?: number;
  otherIncomeExpense?: number;
  netProfit?: number;
}

type DeveloperProfitCorrection = {
  sourceNetProfit: string; effectiveNetProfit: string; adjustment: string; finalized: boolean;
  correction: { reason: string; actorName: string | null } | null;
};

interface SpProfitSplit {
  id: number;
  periodMonth?: string;
  grossProfit?: number;
  ourShare?: number;
  supplierShare?: number;
}

interface LocationOption {
  id: number;
  name: string;
}

function extractAccounts(payload: AccountsResponse | CashAccount[] | undefined): CashAccount[] {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.accounts) ? payload.accounts : [];
}

function fmt(v: number | string | undefined, dec = 2) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n)
    ? `$0.${"0".repeat(dec)}`
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}

function toLocalDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentMonthRange(now = new Date()) {
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const lastDay = new Date(year, monthIndex + 1, 0);

  return {
    key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    from: toLocalDateInputValue(firstDay),
    to: toLocalDateInputValue(lastDay),
  };
}

export default function SpReports() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";
  const [tab, setTab] = useHubQueryState<ReportTab>({
    key: "tab",
    allowedValues: REPORT_TABS,
    defaultValue: "profit",
    omitDefault: true,
  });
  const [startDate, setStartDate] = useState(() => getCurrentMonthRange().from);
  const [endDate, setEndDate] = useState(() => getCurrentMonthRange().to);
  const [exportFrom, setExportFrom] = useState(() => getCurrentMonthRange().from);
  const [exportTo, setExportTo] = useState(() => getCurrentMonthRange().to);
  const [exportLocationId, setExportLocationId] = useState<string>("all");
  const [exportCashAccountId, setExportCashAccountId] = useState<string>("none");
  const [exporting, setExporting] = useState(false);
  const [exportingV2, setExportingV2] = useState(false);
  const [editProfitOpen, setEditProfitOpen] = useState(false);
  const [correctedProfit, setCorrectedProfit] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionConfirmation, setCorrectionConfirmation] = useState("");

  useEffect(() => {
    let activeMonthKey = getCurrentMonthRange().key;

    const syncReportRangesToCurrentMonth = () => {
      const currentMonth = getCurrentMonthRange();
      if (currentMonth.key === activeMonthKey) return;

      activeMonthKey = currentMonth.key;
      setStartDate(currentMonth.from);
      setEndDate(currentMonth.to);
      setExportFrom(currentMonth.from);
      setExportTo(currentMonth.to);
    };

    const intervalId = window.setInterval(syncReportRangesToCurrentMonth, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const profitUrl = `/api/sp/report/profit${
    startDate || endDate
      ? `?${new URLSearchParams({ ...(startDate && { startDate }), ...(endDate && { endDate }) })}`
      : ""
  }`;
  const splitsUrl = "/api/sp/profit-splits";
  const selectedMonth = endDate.slice(0, 7);
  const [yearOfMonth, monthOfYear] = selectedMonth.split("-").map(Number);
  const completeMonth = Number.isInteger(yearOfMonth) && Number.isInteger(monthOfYear) &&
    startDate === `${selectedMonth}-01` &&
    endDate === `${selectedMonth}-${String(new Date(Date.UTC(yearOfMonth, monthOfYear, 0)).getUTCDate()).padStart(2, "0")}`;
  const correctionUrl = `/api/sp/golden-coast/profit-correction?periodMonth=${encodeURIComponent(selectedMonth)}`;
  const { data: developerCorrection } = useQuery<DeveloperProfitCorrection>({
    queryKey: [correctionUrl, selectedCompany?.id], enabled: isDeveloper && completeMonth, retry: false,
  });
  const saveProfitCorrection = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/sp/golden-coast/profit-correction", {
        periodMonth: selectedMonth, targetNetProfit: correctedProfit, reason: correctionReason,
        confirmation: correctionConfirmation,
        idempotencyKey: `sp-profit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      return response.json();
    },
    onSuccess: () => {
      setEditProfitOpen(false);
      setCorrectionReason("");
      setCorrectionConfirmation("");
      void queryClient.invalidateQueries({ queryKey: [correctionUrl, selectedCompany?.id] });
      void queryClient.invalidateQueries({ predicate: ({ queryKey }) =>
        typeof queryKey[0] === "string" && (
          queryKey[0].startsWith("/api/sp/report/profit") ||
          queryKey[0].includes("/phase11/profit-splits/monthly-close/readiness")
        ),
      });
      toast({ title: "Profit correction saved", description: "The correction will be included in the split Journal." });
    },
    onError: (error) => toast({
      title: "Profit correction failed", description: getErrorDetails(error).message, variant: "destructive",
    }),
  });

  const { data: profit, isLoading: profitLoading } = useQuery<SpProfitReport>({ queryKey: [profitUrl] });
  const { data: splits = [], isLoading: splitsLoading } = useQuery<SpProfitSplit[]>({ queryKey: [splitsUrl] });
  const { data: locations = [] } = useQuery<LocationOption[]>({ queryKey: ["/api/locations"] });
  const { data: accountsResponse } = useQuery<AccountsResponse | CashAccount[]>({
    queryKey: ["/api/accounts/all", selectedCompany?.id],
  });
  const accounts = extractAccounts(accountsResponse);

  useEffect(() => {
    const gcSalesCash = accounts.find((account) => account.name.trim().toLowerCase() === "gc sales cash");
    if (!gcSalesCash) return;

    setExportCashAccountId((current) => {
      const currentAccountStillExists = accounts.some((account) => String(account.id) === current);
      return currentAccountStillExists ? current : String(gcSalesCash.id);
    });
  }, [accounts, selectedCompany?.id]);

  const handleExportSalesForm = async () => {
    if (!exportFrom || !exportTo) {
      toast({ title: "Please select both From and To dates", variant: "destructive" });
      return;
    }
    setExporting(true);
    try {
      const params = new URLSearchParams({ fromDate: exportFrom, toDate: exportTo });
      if (exportLocationId && exportLocationId !== "all") params.set("locationId", exportLocationId);
      const res = await fetch(`/api/sp/sales-form/export?${params}`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Export failed" }));
        throw new Error(err.message);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `sales_form_${exportFrom}_${exportTo}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Sales form exported", description: filename });
    } catch (e) {
      toast({ title: "Export failed", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const handleExportSalesFormV2 = async () => {
    if (!exportFrom || !exportTo) {
      toast({ title: "Please select both From and To dates", variant: "destructive" });
      return;
    }
    setExportingV2(true);
    try {
      const params = new URLSearchParams({ fromDate: exportFrom, toDate: exportTo });
      if (exportLocationId && exportLocationId !== "all") params.set("locationId", exportLocationId);
      if (exportCashAccountId && exportCashAccountId !== "none") params.set("cashAccountId", exportCashAccountId);
      const res = await fetch(`/api/sp/sales-form/export-v2?${params}`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Export failed" }));
        throw new Error(err.message);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `system_sales_form_${exportFrom}_${exportTo}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "System sales form exported", description: filename });
    } catch (e) {
      toast({ title: "Export failed", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setExportingV2(false);
    }
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Profit & Loss and Sales Form export</p>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ReportTab)}>
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList
            data-testid="tabs-sp-reports"
            className="w-max min-w-full sm:min-w-0 sm:w-fit"
            aria-label="Supplier Partner reports"
          >
            <TabsTrigger value="profit" data-testid="tab-sp-profit">
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" /> Profit & Loss
            </TabsTrigger>
            <TabsTrigger value="sales-form" data-testid="tab-sp-salesform">
              <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" /> Sales Form
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="profit" className="mt-4 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <label className="text-xs text-muted-foreground">From</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-36"
                data-testid="input-sp-profit-start"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">To</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1 w-36"
                data-testid="input-sp-profit-end"
              />
            </div>
          </div>

          {profitLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : profit ? (
            <>
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <CardTitle className="text-sm">Profit & Loss Summary</CardTitle>
                      <CardDescription className="text-xs">{profit.saleCount} sales in period</CardDescription>
                    </div>
                    {isDeveloper && completeMonth && developerCorrection && (
                      <Button size="sm" variant="outline" disabled={developerCorrection?.finalized === true}
                        data-testid="button-sp-developer-edit-profit"
                        onClick={() => {
                          setCorrectedProfit(String(developerCorrection?.effectiveNetProfit ?? profit.netProfit ?? "0"));
                          setCorrectionReason("");
                          setCorrectionConfirmation("");
                          setEditProfitOpen(true);
                        }}>
                        Edit Profit
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    {[
                      { label: "Total Revenue", value: profit.totalRevenue ?? 0, className: "text-green-600" },
                      {
                        label: "COGS (base + landed)",
                        value: -(profit.totalCogs ?? 0),
                        className: "text-destructive",
                      },
                      {
                        label: "Gross Profit",
                        value: profit.grossProfit ?? 0,
                        className: "font-semibold border-t border-border/40 pt-1 mt-1",
                      },
                      {
                        label: "Shared Charges",
                        value: -(profit.totalSharedCharges ?? 0),
                        className: "text-destructive",
                      },
                      ...((profit.otherIncomeExpense ?? 0) !== 0 ? [{
                        label: "Other Income / (Expense)",
                        value: profit.otherIncomeExpense ?? 0,
                        className: "text-muted-foreground",
                      }] : []),
                      {
                        label: "Net Profit",
                        value: profit.netProfit ?? 0,
                        className: "font-bold border-t border-border/40 pt-1 mt-1 text-base",
                      },
                    ].map((row, i) => (
                      <div
                        key={i}
                        className={`flex items-center justify-between text-sm py-0.5 ${row.className || ""}`}
                        data-testid={`row-sp-pl-${i}`}
                      >
                        <span>{row.label}</span>
                        <span className="tabular-nums">
                          {fmt(Math.abs(row.value))}
                          {row.value < 0 ? " (cost)" : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Profit Split</CardTitle>
                  <CardDescription className="text-xs">
                    Choose the report month and split it using the ledger-derived Golden Coast monthly close.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <QuickMonthlyClose
                    periodMonth={endDate.length >= 7 ? endDate.slice(0, 7) : ""}
                    companyKey={selectedCompany?.id ?? "no-company"}
                  />
                </CardContent>
              </Card>
            </>
          ) : null}

          {!splitsLoading && splits.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Finalized Splits</h3>
              {splits.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between text-xs py-1.5 border-b border-border/30"
                  data-testid={`row-sp-split-${s.id}`}
                >
                  <span className="font-mono">{s.periodMonth}</span>
                  <span className="text-muted-foreground">Net {fmt(Number(s.ourShare ?? 0) + Number(s.supplierShare ?? 0))}</span>
                  <span className="text-green-600">Our: {fmt(s.ourShare)}</span>
                  <span className="text-orange-600">Sup: {fmt(s.supplierShare)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="sales-form" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Export Sales Form Excel</CardTitle>
              <CardDescription className="text-xs">
                Downloads the same workbook format as the supplier sales form — Costing, Sales, ENTRY, Summary, and
                Summary-Itemwise sheets filled with current data.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-3 flex-wrap">
                <div>
                  <label className="text-xs text-muted-foreground">From</label>
                  <Input
                    type="date"
                    value={exportFrom}
                    onChange={(e) => setExportFrom(e.target.value)}
                    className="mt-1 w-36"
                    data-testid="input-sp-export-from"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">To</label>
                  <Input
                    type="date"
                    value={exportTo}
                    onChange={(e) => setExportTo(e.target.value)}
                    className="mt-1 w-36"
                    data-testid="input-sp-export-to"
                  />
                </div>
                <div className="min-w-40">
                  <label className="text-xs text-muted-foreground">Location (optional)</label>
                  <Select
                    value={exportLocationId}
                    onValueChange={setExportLocationId}
                    data-testid="select-sp-export-location"
                  >
                    <SelectTrigger className="mt-1" data-testid="select-sp-export-location-trigger">
                      <SelectValue placeholder="All locations" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All locations</SelectItem>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={String(l.id)} data-testid={`option-location-${l.id}`}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-48">
                  <label className="text-xs text-muted-foreground">Opening Cash Account</label>
                  <Select
                    value={exportCashAccountId}
                    onValueChange={setExportCashAccountId}
                    data-testid="select-sp-export-cash-account"
                  >
                    <SelectTrigger className="mt-1" data-testid="select-sp-export-cash-account-trigger">
                      <SelectValue placeholder="GC Sales Cash" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No account (manual entry)</SelectItem>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)} data-testid={`option-cash-account-${a.id}`}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-wrap gap-3 pt-1">
                <Button
                  onClick={handleExportSalesForm}
                  disabled={exporting || exportingV2 || !exportFrom || !exportTo}
                  variant="outline"
                  data-testid="button-sp-export-sales-form"
                >
                  {exporting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <FileSpreadsheet className="h-4 w-4 mr-2" /> Export Template Form
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleExportSalesFormV2}
                  disabled={exporting || exportingV2 || !exportFrom || !exportTo}
                  data-testid="button-sp-export-sales-form-v2"
                >
                  {exportingV2 ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <FileSpreadsheet className="h-4 w-4 mr-2" /> Export System Sales Form
                    </>
                  )}
                </Button>
              </div>

              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Export Template Form</span> — fills the original
                  supplier template with your data (18-day max, formula-based).
                </p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Export System Sales Form</span> — clean from-scratch
                  workbook built from your live system data. Opening &amp; closing stock match the Location Inventory
                  page. Supports any date range. Three sheets: ENTRY (visible) plus Costing and Sales (hidden). Items
                  with no opening, closing, or sales activity are omitted. Opening cash defaults to GC Sales Cash when
                  that account exists for the selected company.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      {isDeveloper && (
        <Dialog open={editProfitOpen} onOpenChange={setEditProfitOpen}>
          <DialogContent data-testid="dialog-sp-developer-profit-correction">
            <DialogHeader>
              <DialogTitle>Correct Net Profit — {selectedMonth}</DialogTitle>
              <DialogDescription>
                Developer only. Set the final monthly profit; the original POS sales stay unchanged.
                The closing Journal will include a balanced correction.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="text-sm">Original profit: {fmt(developerCorrection?.sourceNetProfit)}</div>
              <label className="block text-sm font-medium" htmlFor="sp-correct-net-profit">Correct final profit (USD)</label>
              <Input id="sp-correct-net-profit" type="number" step="0.01" value={correctedProfit}
                onChange={(event) => setCorrectedProfit(event.target.value)} data-testid="input-sp-correct-profit" />
              <label className="block text-sm font-medium" htmlFor="sp-correct-profit-reason">Reason (developer audit only)</label>
              <Input id="sp-correct-profit-reason" value={correctionReason} maxLength={500}
                onChange={(event) => setCorrectionReason(event.target.value)} data-testid="input-sp-profit-correction-reason" />
              <p className="text-xs text-muted-foreground">
                Any difference posts to a suspense ledger at the monthly close and must be reconciled later.
              </p>
              <label className="block text-sm font-medium" htmlFor="sp-correct-profit-confirm">Type ADJUST SP PROFIT</label>
              <Input id="sp-correct-profit-confirm" value={correctionConfirmation}
                onChange={(event) => setCorrectionConfirmation(event.target.value)} />
              {developerCorrection?.correction && (
                <div className="text-xs text-muted-foreground" data-testid="sp-profit-correction-audit">
                  Previous correction: {developerCorrection.correction.reason}
                  {" — "}{developerCorrection.correction.actorName || "Developer"}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditProfitOpen(false)}>Cancel</Button>
              <Button disabled={saveProfitCorrection.isPending || correctionReason.trim().length < 5 ||
                correctionConfirmation !== "ADJUST SP PROFIT" || !/^-?[0-9]+(?:[.][0-9]{1,2})?$/.test(correctedProfit)}
                onClick={() => saveProfitCorrection.mutate()} data-testid="button-sp-save-correct-profit">
                {saveProfitCorrection.isPending ? "Saving..." : "Save Corrected Profit"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
