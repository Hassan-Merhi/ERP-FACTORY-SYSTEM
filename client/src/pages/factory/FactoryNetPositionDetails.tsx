import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus,
  Minus,
  Equal,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Eye,
  EyeOff,
  RotateCcw,
  ExternalLink,
  CalendarDays,
} from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

interface AccountItem {
  id?: number;
  name: string;
  code: string;
  value: number;
  category: string;
}

interface BreakdownItem {
  name: string;
  value: number;
}

interface FactoryNetPositionData {
  forUsTotal: number;
  onUsTotal: number;
  netPosition: number;
  netPositionLabel: string;
  forUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  onUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  supplierLiabilities: number;
  inventoryValue: number;
  rawMaterialValue: number;
  ledgerAssets: number;
  ledgerLiabilities: number;
}

function InsuranceSubGroup({
  accounts,
  amountColor,
  formatAmount,
}: {
  accounts: AccountItem[];
  amountColor: string;
  formatAmount: (n: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const total = accounts.reduce((s, a) => s + Math.abs(a.value), 0);

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 text-sm border-t border-border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 font-medium text-foreground hover-elevate rounded px-1 -ml-1"
          data-testid="button-insurance-group-toggle"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          Insurance
          <Badge variant="outline" className="text-xs font-normal ml-0.5">
            {accounts.length}
          </Badge>
        </button>
        <span className={`font-mono tabular-nums ${amountColor}`}>{formatAmount(total)}</span>
      </div>
      {open &&
        accounts.map((acc, i) => (
          <div
            key={i}
            className="flex items-center justify-between pl-10 pr-4 py-2 text-sm border-t border-border bg-muted/20"
            data-testid={`row-insurance-${i}`}
          >
            {acc.id ? (
              <button
                type="button"
                onClick={() => window.open(`/factory/ledger-monthly/${acc.id}`, "_blank")}
                className="font-medium text-foreground hover:underline text-left flex items-center gap-1"
              >
                {acc.name.replace(/^Insurance\s*[-–]\s*/i, "")}
                <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
              </button>
            ) : (
              <span className="font-medium text-foreground">{acc.name.replace(/^Insurance\s*[-–]\s*/i, "")}</span>
            )}
            <span className={`font-mono tabular-nums ${amountColor}`}>{formatAmount(Math.abs(acc.value))}</span>
          </div>
        ))}
    </>
  );
}

function CategoryGroup({
  category,
  accounts,
  amountColor,
  formatAmount,
  accentColor,
}: {
  category: string;
  accounts: AccountItem[];
  amountColor: string;
  formatAmount: (n: number) => string;
  accentColor: string;
}) {
  const [open, setOpen] = useState(true);
  const total = accounts.reduce((s, a) => s + Math.abs(a.value), 0);

  const insuranceAccounts = accounts.filter((a) => /^Insurance\s*[-–]/i.test(a.name));
  const otherAccounts = accounts.filter((a) => !/^Insurance\s*[-–]/i.test(a.name));
  const displayCount = otherAccounts.length + (insuranceAccounts.length > 0 ? 1 : 0);

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/40 hover-elevate text-sm font-semibold"
        data-testid={`button-category-${category.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span>{category}</span>
          <Badge variant="outline" className="text-xs font-normal">
            {displayCount}
          </Badge>
        </div>
        <span className={`font-mono font-bold ${accentColor}`}>{formatAmount(total)}</span>
      </button>
      {open && (
        <div className="divide-y divide-border">
          {otherAccounts.map((acc, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-4 py-2 text-sm"
              data-testid={`row-account-${i}`}
            >
              {acc.id ? (
                <button
                  type="button"
                  onClick={() => window.open(`/factory/ledger-monthly/${acc.id}`, "_blank")}
                  className="font-medium text-foreground hover:underline text-left flex items-center gap-1"
                >
                  {acc.name}
                  <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                </button>
              ) : (
                <span className="font-medium text-foreground">{acc.name}</span>
              )}
              <span className={`font-mono tabular-nums ${amountColor}`}>{formatAmount(Math.abs(acc.value))}</span>
            </div>
          ))}
          {insuranceAccounts.length > 0 && (
            <InsuranceSubGroup accounts={insuranceAccounts} amountColor={amountColor} formatAmount={formatAmount} />
          )}
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({
  id,
  title,
  subtitle,
  accentColor,
  icon,
  total,
  totalLabel,
  totalColor,
  accounts,
  amountColor,
  formatAmount,
}: {
  id: string;
  title: string;
  subtitle?: string;
  accentColor: string;
  icon: React.ReactNode;
  total: number;
  totalLabel: string;
  totalColor: string;
  accounts: AccountItem[];
  amountColor: string;
  formatAmount: (n: number) => string;
}) {
  const [open, setOpen] = useState(true);

  const grouped = accounts.reduce<Record<string, AccountItem[]>>((acc, item) => {
    const cat = item.category || "Other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  const sortedCategories = Object.entries(grouped).sort(
    ([, a], [, b]) => b.reduce((s, x) => s + Math.abs(x.value), 0) - a.reduce((s, x) => s + Math.abs(x.value), 0)
  );

  return (
    <Card data-testid={`card-${id}`} className="flex flex-col">
      <CardHeader className="cursor-pointer select-none pb-3" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className={accentColor}>{icon}</span>
            <div>
              <CardTitle className={`flex items-center gap-2 text-lg ${accentColor}`}>{title}</CardTitle>
              {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-bold font-mono ${totalColor}`}>{formatAmount(total)}</span>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
          </div>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 flex-1 space-y-2">
          {sortedCategories.length > 0 ? (
            <>
              {sortedCategories.map(([cat, catAccounts]) => (
                <CategoryGroup
                  key={cat}
                  category={cat}
                  accounts={catAccounts}
                  amountColor={amountColor}
                  formatAmount={formatAmount}
                  accentColor={totalColor}
                />
              ))}
              <div className="flex justify-between items-center px-4 py-2.5 rounded-md bg-muted/60 font-bold text-sm mt-1">
                <span>{totalLabel}</span>
                <span className={`font-mono ${totalColor}`}>{formatAmount(total)}</span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-center py-4">No data recorded</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function formatDateLabel(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

const STORAGE_KEY = "netpos_details_custom_view_hidden";

interface PayrollEmployee {
  id: number;
  name: string;
  code: string;
  balance: number;
}

function CustomNetPositionView({
  data,
  formatAmount,
  asOf,
}: {
  data: FactoryNetPositionData;
  formatAmount: (n: number) => string;
  asOf: string;
}) {
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  // Fetch per-employee payroll breakdown
  const { data: payrollData } = useQuery<{ employees: PayrollEmployee[] }>({
    queryKey: ["/api/factory/net-position/payroll-breakdown", asOf],
    queryFn: async () => {
      const res = await fetch(`/api/factory/net-position/payroll-breakdown?asOf=${asOf}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 30_000,
  });

  const payrollEmployees = useMemo(() => payrollData?.employees ?? [], [payrollData?.employees]);

  const toggleKey = useCallback((key: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
      }
      return next;
    });
  }, []);

  const showAll = useCallback(() => {
    setHiddenKeys(new Set());
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
    }
  }, []);

  const forUsAccounts = useMemo(
    () => (data.forUs.accounts || []).map((a) => ({ ...a, side: "forUs" as const })),
    [data]
  );

  // Exclude the aggregated "Payroll Payable" row — rendered as individual employee rows instead
  const onUsAccounts = useMemo(
    () =>
      (data.onUs.accounts || [])
        .filter((a) => a.name !== "Payroll Payable")
        .map((a) => ({ ...a, side: "onUs" as const })),
    [data]
  );

  const visibleForUs = useMemo(
    () => forUsAccounts.filter((a) => !hiddenKeys.has(`forUs:${a.name}`)),
    [forUsAccounts, hiddenKeys]
  );
  const visibleOnUs = useMemo(
    () => onUsAccounts.filter((a) => !hiddenKeys.has(`onUs:${a.name}`)),
    [onUsAccounts, hiddenKeys]
  );
  const visiblePayrollTotal = useMemo(
    () => payrollEmployees.filter((e) => !hiddenKeys.has(`payroll:${e.id}`)).reduce((s, e) => s + e.balance, 0),
    [payrollEmployees, hiddenKeys]
  );

  const visibleForUsTotal = visibleForUs.reduce((s, a) => s + Math.abs(a.value), 0);
  const visibleOnUsTotal = visibleOnUs.reduce((s, a) => s + Math.abs(a.value), 0) + visiblePayrollTotal;
  const customNet = visibleForUsTotal - visibleOnUsTotal;
  const isPositive = customNet >= 0;

  return (
    <Card data-testid="card-custom-net-position">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base">Custom Net Position View</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Hide accounts to see an adjusted subtotal — does not affect the real Net Position
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hiddenKeys.size > 0 && (
              <Button size="sm" variant="outline" onClick={showAll} data-testid="button-show-all-accounts">
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                Show all ({hiddenKeys.size} hidden)
              </Button>
            )}
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-bold font-mono ${isPositive ? "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300" : "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300"}`}
            >
              <Equal className="h-3.5 w-3.5" />
              {formatAmount(customNet)}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* What We Have */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 mb-2">
              <Plus className="h-3.5 w-3.5 text-green-600 shrink-0" />
              <span className="text-xs font-semibold text-green-600 uppercase tracking-wide">What We Have</span>
            </div>
            {forUsAccounts.map((a) => {
              const key = `forUs:${a.name}`;
              const hidden = hiddenKeys.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleKey(key)}
                  data-testid={`button-toggle-${key}`}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-sm hover-elevate transition-opacity ${hidden ? "opacity-40" : ""}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {hidden ? (
                      <EyeOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    )}
                    <span className={hidden ? "text-muted-foreground line-through" : "text-foreground"}>{a.name}</span>
                    {a.id && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(`/factory/ledger-monthly/${a.id}`, "_blank");
                        }}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        data-testid={`link-ledger-forus-${a.id}`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </span>
                    )}
                  </div>
                  <span className={`font-mono tabular-nums ${hidden ? "text-muted-foreground" : "text-green-600"}`}>
                    {formatAmount(Math.abs(a.value))}
                  </span>
                </button>
              );
            })}
            <div className="flex justify-between items-center px-3 py-2 rounded-md bg-green-50 dark:bg-green-950/30 mt-1">
              <span className="text-xs font-semibold text-green-700 dark:text-green-300">Visible subtotal</span>
              <span className="font-mono font-bold text-green-600">{formatAmount(visibleForUsTotal)}</span>
            </div>
          </div>

          {/* What We Owe */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 mb-2">
              <Minus className="h-3.5 w-3.5 text-red-600 shrink-0" />
              <span className="text-xs font-semibold text-red-600 uppercase tracking-wide">What We Owe</span>
            </div>

            {/* Regular onUs account rows */}
            {onUsAccounts.map((a) => {
              const key = `onUs:${a.name}`;
              const hidden = hiddenKeys.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleKey(key)}
                  data-testid={`button-toggle-${key}`}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-sm hover-elevate transition-opacity ${hidden ? "opacity-40" : ""}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {hidden ? (
                      <EyeOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 text-red-500 shrink-0" />
                    )}
                    <span className={hidden ? "text-muted-foreground line-through" : "text-foreground"}>{a.name}</span>
                    {a.id && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(`/factory/ledger-monthly/${a.id}`, "_blank");
                        }}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        data-testid={`link-ledger-onus-${a.id}`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </span>
                    )}
                  </div>
                  <span className={`font-mono tabular-nums ${hidden ? "text-muted-foreground" : "text-red-600"}`}>
                    {formatAmount(Math.abs(a.value))}
                  </span>
                </button>
              );
            })}

            {/* Payroll Payable — broken into per-employee rows */}
            {payrollEmployees.length > 0 && (
              <>
                <div className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="font-medium text-foreground">Payroll Payable</span>
                </div>
                {payrollEmployees.map((emp) => {
                  const key = `payroll:${emp.id}`;
                  const hidden = hiddenKeys.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleKey(key)}
                      data-testid={`button-toggle-${key}`}
                      className={`w-full flex items-center justify-between pl-6 pr-3 py-2 rounded-md text-sm hover-elevate transition-opacity ${hidden ? "opacity-40" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        {hidden ? (
                          <EyeOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        ) : (
                          <Eye className="h-3.5 w-3.5 text-red-500 shrink-0" />
                        )}
                        <span className={hidden ? "text-muted-foreground line-through" : "text-foreground"}>
                          {emp.name}
                        </span>
                      </div>
                      <span className={`font-mono tabular-nums ${hidden ? "text-muted-foreground" : "text-red-600"}`}>
                        {formatAmount(emp.balance)}
                      </span>
                    </button>
                  );
                })}
              </>
            )}

            <div className="flex justify-between items-center px-3 py-2 rounded-md bg-red-50 dark:bg-red-950/30 mt-1">
              <span className="text-xs font-semibold text-red-700 dark:text-red-300">Visible subtotal</span>
              <span className="font-mono font-bold text-red-600">{formatAmount(visibleOnUsTotal)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function FactoryNetPositionDetails() {
  const { formatAmount } = useCurrencyContext();
  const [asOf, setAsOf] = useState<string>(todayStr);
  const isToday = asOf === todayStr();

  const { data, isLoading, error, refetch, isFetching } = useQuery<FactoryNetPositionData>({
    queryKey: ["/api/factory/net-position", asOf],
    queryFn: async () => {
      const res = await fetch(`/api/factory/net-position?asOf=${asOf}`, { credentials: "include" });
      if (!res.ok) {
        const text = await res.text();
        // Attach the parsed code so the retry handler can inspect it
        const err: Error & { code?: string } = new Error(text);
        try {
          err.code = JSON.parse(text)?.code;
        } catch {
          // Malformed or absent payload — fall through to the default rather than surface a parse error.
        }
        throw err;
      }
      return res.json();
    },
    staleTime: isToday ? 60_000 : Infinity,
    refetchOnWindowFocus: false,
    // Auto-retry when the concurrency guard fires (max 3 attempts, 6 s apart)
    retry: (failureCount, err: any) => (err?.code === "ENDPOINT_BUSY" ? failureCount < 3 : false),
    retryDelay: (_, err: any) => (err?.code === "ENDPOINT_BUSY" ? 6_000 : 0),
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    const errAny = error as unknown as { code: unknown };
    const isEndpointBusy = errAny?.code === "ENDPOINT_BUSY";
    const friendlyMessage = isEndpointBusy
      ? "The report is already being generated. It will retry automatically in a few seconds…"
      : (() => {
          try {
            const parsed = JSON.parse((error as Error).message);
            return parsed?.message ?? (error as Error).message;
          } catch {
            return (error as Error).message;
          }
        })();

    return (
      <div className="p-6">
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span>{friendlyMessage}</span>
            </div>
            {!isEndpointBusy && (
              <button className="mt-3 text-sm underline text-muted-foreground" onClick={() => refetch()}>
                Try again
              </button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const net = data?.netPosition ?? 0;
  const isPositive = net >= 0;

  return (
    <div className="p-4 md:p-6 space-y-4 w-full">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <PageHeader
            title="Factory Net Position"
            subtitle={
              isToday
                ? "Current factory financial standing — what we have vs what we owe"
                : `Historical snapshot — as of ${formatDateLabel(asOf)}`
            }
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Date navigation */}
          <div className="flex items-center gap-1 border rounded-md px-1 py-0.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAsOf(shiftDate(asOf, -1))}
              data-testid="button-date-prev"
              title="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1.5 px-1">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="date"
                value={asOf}
                max={todayStr()}
                onChange={(e) => e.target.value && setAsOf(e.target.value)}
                className="text-sm bg-transparent border-none outline-none cursor-pointer w-[120px]"
                data-testid="input-as-of-date"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAsOf(shiftDate(asOf, 1))}
              disabled={isToday}
              data-testid="button-date-next"
              title="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {!isToday && (
            <Button variant="outline" size="sm" onClick={() => setAsOf(todayStr())} data-testid="button-date-today">
              Today
            </Button>
          )}
          {isToday && (
            <Button
              variant="outline"
              size="default"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-refresh"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          )}
        </div>
      </div>

      <Card data-testid="card-formula">
        <CardContent className="pt-5">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 bg-green-50 dark:bg-green-950/40 px-4 py-2.5 rounded-md">
              <span className="text-sm font-medium text-green-700 dark:text-green-300">What We Have</span>
              <span className="font-bold font-mono text-green-600">{formatAmount(data?.forUsTotal || 0)}</span>
            </div>
            <Minus className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-2 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 rounded-md">
              <span className="text-sm font-medium text-red-700 dark:text-red-300">What We Owe</span>
              <span className="font-bold font-mono text-red-600">{formatAmount(data?.onUsTotal || 0)}</span>
            </div>
            <Equal className="h-4 w-4 text-muted-foreground shrink-0" />
            <div
              className={`flex items-center gap-2 px-4 py-2.5 rounded-md ${isPositive ? "bg-green-100 dark:bg-green-900/40" : "bg-red-100 dark:bg-red-900/40"}`}
            >
              <span
                className={`text-sm font-medium ${isPositive ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"}`}
              >
                Net Position
              </span>
              <span className={`font-bold font-mono ${isPositive ? "text-green-600" : "text-red-600"}`}>
                {formatAmount(net)}
              </span>
            </div>
            <Badge variant={isPositive ? "default" : "destructive"} className="ml-auto sm:ml-2">
              {data?.netPositionLabel || "Net Position"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <CollapsibleSection
          id="assets"
          title="What We Have"
          subtitle={`${data?.forUs.accounts?.length || 0} asset accounts`}
          accentColor="text-green-600"
          icon={<Plus className="h-5 w-5" />}
          total={data?.forUsTotal || 0}
          totalLabel="Total Assets"
          totalColor="text-green-600"
          accounts={data?.forUs.accounts || []}
          amountColor="text-green-600"
          formatAmount={formatAmount}
        />
        <CollapsibleSection
          id="liabilities"
          title="What We Owe"
          subtitle={`${data?.onUs.accounts?.length || 0} liability accounts`}
          accentColor="text-red-600"
          icon={<Minus className="h-5 w-5" />}
          total={data?.onUsTotal || 0}
          totalLabel="Total Liabilities"
          totalColor="text-red-600"
          accounts={data?.onUs.accounts || []}
          amountColor="text-red-600"
          formatAmount={formatAmount}
        />
      </div>

      {data && <CustomNetPositionView data={data} formatAmount={formatAmount} asOf={asOf} />}
    </div>
  );
}
