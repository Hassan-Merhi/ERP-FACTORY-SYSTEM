import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Save, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { RetailNav } from "./RetailNav";

interface FinanceAccountsResponse {
  accountKeys: string[];
  accounts: Array<{ id: number; code: string; name: string; accountType: string; active: boolean }>;
  mappings: Record<string, number>;
  configured: boolean;
  missing: string[];
}
interface ReconciliationCheck {
  key: string;
  label: string;
  expected: string;
  actual: string;
  difference: string;
  mismatch: boolean;
}
interface ReconciliationReport {
  status: "MISMATCH" | "RECONCILED";
  hasMismatch: boolean;
  alert: string;
  transactionCounts: { sales: number; returns: number; postings: number; payments: number };
  totals: Record<string, string>;
  checks: ReconciliationCheck[];
  mismatches: ReconciliationCheck[];
}
interface Location {
  id: number;
  name: string;
}

const ACCOUNT_LABELS: Record<string, string> = {
  cash: "Cash",
  card_clearing: "Card / Payment Clearing",
  bank: "Bank / Transfer",
  sales_revenue: "Retail Sales Revenue",
  inventory_asset: "Inventory Asset",
  cogs: "Cost of Goods Sold",
  discounts: "Discounts",
  tax_payable: "Tax Payable",
  store_credit_liability: "Store Credit Liability",
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

const money = (value: string | number | undefined) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value ?? 0));
const isoDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export default function RetailFinancials() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const now = new Date();
  const [from, setFrom] = useState(isoDate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(isoDate(now));
  const [locationId, setLocationId] = useState("");
  const [mappingDraft, setMappingDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const accountsQuery = useQuery({
    queryKey: ["retail-financial-accounts", selectedCompany?.id],
    queryFn: () => getJson<FinanceAccountsResponse>("/api/retail/finance/accounts"),
    enabled: selectedCompany?.companyType === "retail",
  });
  const locationsQuery = useQuery({
    queryKey: ["retail-finance-locations", selectedCompany?.id],
    queryFn: () => getJson<Location[]>("/api/locations"),
    enabled: selectedCompany?.companyType === "retail",
  });
  const reconciliationUrl = useMemo(() => {
    const params = new URLSearchParams({ from, to });
    if (locationId) params.set("locationId", locationId);
    return `/api/retail/finance/reconciliation?${params.toString()}`;
  }, [from, locationId, to]);
  const reconciliationQuery = useQuery({
    queryKey: ["retail-financial-reconciliation", selectedCompany?.id, from, to, locationId],
    queryFn: () => getJson<ReconciliationReport>(reconciliationUrl),
    enabled: selectedCompany?.companyType === "retail",
  });

  useEffect(() => {
    const mappings = accountsQuery.data?.mappings;
    if (mappings)
      setMappingDraft(Object.fromEntries(Object.entries(mappings).map(([key, value]) => [key, String(value)])));
  }, [accountsQuery.data]);

  const saveMappings = async () => {
    const data = accountsQuery.data;
    if (!data) return;
    const mappings = Object.fromEntries(data.accountKeys.map((key) => [key, Number(mappingDraft[key] || 0)]));
    if (data.accountKeys.some((key) => !Number.isInteger(mappings[key]) || mappings[key] <= 0)) {
      toast({
        title: "Map all Retail accounts",
        description: "Choose one active ledger account for every required row.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/retail/finance/accounts", { mappings });
      await accountsQuery.refetch();
      toast({ title: "Retail account mappings saved" });
    } catch (error) {
      toast({
        title: "Could not save mappings",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (selectedCompany?.companyType !== "retail") return null;
  const report = reconciliationQuery.data;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-3 md:p-5">
      <RetailNav />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Retail Payments & Accounting</h1>
        <p className="text-sm text-muted-foreground">
          Connect Retail tenders and financial activity to the shared ERP ledger.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Retail accounting accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sales, returns and cancellations require all mappings to active ledger accounts in this company. Existing
            voucher postings keep their original mapped-account snapshot.
          </p>
          {accountsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading ledger accounts…</div>
          ) : accountsQuery.error ? (
            <div className="text-sm text-destructive">{accountsQuery.error.message}</div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {(accountsQuery.data?.accountKeys ?? []).map((key) => (
                <div key={key}>
                  <Label htmlFor={`retail-account-${key}`}>{ACCOUNT_LABELS[key] ?? key}</Label>
                  <select
                    id={`retail-account-${key}`}
                    value={mappingDraft[key] ?? ""}
                    onChange={(event) => setMappingDraft((current) => ({ ...current, [key]: event.target.value }))}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="">Choose account</option>
                    {(accountsQuery.data?.accounts ?? []).map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} · {account.name} ({account.accountType})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <div
              className={`flex items-center gap-2 text-sm ${accountsQuery.data?.configured ? "text-emerald-700" : "text-amber-800"}`}
            >
              {accountsQuery.data?.configured ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              {accountsQuery.data?.configured
                ? "All required Retail accounts are mapped."
                : `Missing: ${(accountsQuery.data?.missing ?? []).map((key) => ACCOUNT_LABELS[key] ?? key).join(", ") || "choose each mapping"}`}
            </div>
            <Button onClick={() => void saveMappings()} disabled={saving || accountsQuery.isLoading}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? "Saving…" : "Save mappings"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SearchCheck className="h-5 w-5" /> Reconciliation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="retail-reconcile-from">From</Label>
              <Input
                id="retail-reconcile-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="retail-reconcile-to">To</Label>
              <Input id="retail-reconcile-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="retail-reconcile-location">Location</Label>
              <select
                id="retail-reconcile-location"
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">All locations</option>
                {(locationsQuery.data ?? []).map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {reconciliationQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Reconciling Retail transactions…</div>
          ) : reconciliationQuery.error ? (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {reconciliationQuery.error.message}
            </div>
          ) : (
            report && (
              <>
                <div
                  className={`flex items-start gap-3 rounded-lg border p-4 ${report.hasMismatch ? "border-destructive bg-destructive/10 text-destructive" : "border-emerald-600/40 bg-emerald-50 text-emerald-900"}`}
                  role="status"
                  aria-live="polite"
                >
                  {report.hasMismatch ? (
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                  )}
                  <div>
                    <div className="font-bold">
                      {report.hasMismatch ? "MISMATCH — review before period close" : "RECONCILED"}
                    </div>
                    <div className="text-sm">{report.alert}</div>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    ["Net Retail sales", report.totals.netRetailTotal],
                    ["Net payments", report.totals.netPayments],
                    ["Posted accounting total", report.totals.accountingTotal],
                    ["Posted net revenue", report.totals.accountingRevenue],
                    ["Net COGS", report.totals.accountingCogs],
                    ["Inventory movement value", report.totals.inventoryMovementCogs],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="mt-1 text-xl font-semibold tabular-nums">{money(value)}</div>
                    </div>
                  ))}
                </div>
                <div className="overflow-hidden rounded-lg border">
                  <div className="grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(90px,0.7fr))] gap-2 bg-muted/50 px-3 py-2 text-xs font-semibold">
                    <span>Check</span>
                    <span>Expected</span>
                    <span>Actual</span>
                    <span>Difference</span>
                  </div>
                  {report.checks.map((check) => (
                    <div
                      key={check.key}
                      className={`grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(90px,0.7fr))] gap-2 border-t px-3 py-2 text-sm ${check.mismatch ? "bg-destructive/5 font-medium text-destructive" : ""}`}
                    >
                      <span>{check.label}</span>
                      <span>{money(check.expected)}</span>
                      <span>{money(check.actual)}</span>
                      <span>{money(check.difference)}</span>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-muted-foreground">
                  Events: {report.transactionCounts.sales} checkouts · {report.transactionCounts.returns} returns ·{" "}
                  {report.transactionCounts.payments} payment lines · {report.transactionCounts.postings} accounting
                  postings
                </div>
              </>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
