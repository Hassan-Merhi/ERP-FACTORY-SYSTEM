import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Minus, Equal, Eye, EyeOff, RotateCcw, ExternalLink } from "lucide-react";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { AccountItem, FactoryNetPositionData } from "../detailsTypes";

/**
 * The Details page's Custom Net Position View: hide rows for an adjusted
 * subtotal (stored per company) and split Payroll Payable into employees
 * when the dated breakdown reconciles to the parent row.
 */
const STORAGE_KEY = "netpos_details_custom_view_hidden";

interface PayrollEmployee {
  id: number;
  name: string;
  code: string;
  balance: number;
}

/** Reuse name-based saved hide keys except where duplicate names need distinct controls. */
function rowVisibilityKey(side: "forUs" | "onUs", account: AccountItem, index: number, rows: AccountItem[]) {
  return rows.filter((row) => row.name === account.name).length > 1
    ? `${side}:${account.id != null ? `ledger:${account.id}` : `${account.code}:${account.name}:${index}`}`
    : `${side}:${account.name}`;
}

export function CustomNetPositionView({
  data,
  formatAmount,
  asOf,
}: {
  data: FactoryNetPositionData;
  formatAmount: (n: number) => string;
  asOf: string;
}) {
  const storageKey = `${STORAGE_KEY}:${data.companyId ?? "no-company"}`;
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => {
    try {
      // Fall back once to the pre-company key so existing choices survive.
      const saved = localStorage.getItem(storageKey) ?? localStorage.getItem(STORAGE_KEY);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  // Fetch per-employee payroll breakdown
  const { data: payrollData, isError: isPayrollError } = useQuery<{
    employees: PayrollEmployee[];
    asOf: string;
    companyId?: number;
  }>({
    queryKey: companyQueryKey("/api/factory/net-position/payroll-breakdown", data.companyId, asOf),
    enabled: data.companyId != null,
    queryFn: async () => {
      const res = await fetch(`/api/factory/net-position/payroll-breakdown?asOf=${asOf}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 30_000,
  });

  const payrollRow = data.onUs.accounts.find((a) => a.code === "EMPLOYEE_PAYROLL_PAYABLE");
  const payrollMatchesReport =
    !!payrollData &&
    payrollData.asOf === asOf &&
    payrollData.companyId === data.companyId &&
    Math.round((payrollData.employees ?? []).reduce((sum, employee) => sum + employee.balance, 0) * 100) ===
      Math.round((payrollRow?.value ?? 0) * 100);
  // Preserve an existing saved hide choice for the aggregate payable.
  // When hidden, keep the aggregate row hidden rather than exposing new
  // visible employee rows as soon as the breakdown finishes loading.
  const splitPayroll = payrollMatchesReport && !hiddenKeys.has("onUs:Payroll Payable");
  // Never drop the aggregate while the breakdown is loading or inconsistent.
  const payrollEmployees = useMemo(
    () => (splitPayroll ? (payrollData?.employees ?? []) : []),
    [splitPayroll, payrollData?.employees]
  );

  const toggleKey = useCallback(
    (key: string) => {
      setHiddenKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
        }
        return next;
      });
    },
    [storageKey]
  );

  const showAll = useCallback(() => {
    setHiddenKeys(new Set());
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
    }
  }, [storageKey]);

  const forUsAccounts = useMemo(
    () => (data.forUs.accounts || []).map((a) => ({ ...a, side: "forUs" as const })),
    [data]
  );

  // Exclude the aggregated "Payroll Payable" row — rendered as individual employee rows instead
  const onUsAccounts = useMemo(
    () =>
      (data.onUs.accounts || [])
        .filter((a) => !(splitPayroll && a.code === "EMPLOYEE_PAYROLL_PAYABLE"))
        .map((a) => ({ ...a, side: "onUs" as const })),
    [data, splitPayroll]
  );

  const visibleForUs = useMemo(
    () => forUsAccounts.filter((a, index) => !hiddenKeys.has(rowVisibilityKey("forUs", a, index, forUsAccounts))),
    [forUsAccounts, hiddenKeys]
  );
  const visibleOnUs = useMemo(
    () => onUsAccounts.filter((a, index) => !hiddenKeys.has(rowVisibilityKey("onUs", a, index, onUsAccounts))),
    [onUsAccounts, hiddenKeys]
  );
  const visiblePayrollTotal = useMemo(
    () => payrollEmployees.filter((e) => !hiddenKeys.has(`payroll:${e.id}`)).reduce((s, e) => s + e.balance, 0),
    [payrollEmployees, hiddenKeys]
  );

  // Count only hidden keys that match a row on screen for this date.
  const hiddenShownCount = useMemo(() => {
    const keys = new Set([
      ...forUsAccounts.map((a, index) => rowVisibilityKey("forUs", a, index, forUsAccounts)),
      ...onUsAccounts.map((a, index) => rowVisibilityKey("onUs", a, index, onUsAccounts)),
      ...payrollEmployees.map((e) => `payroll:${e.id}`),
    ]);
    return [...hiddenKeys].filter((key) => keys.has(key)).length;
  }, [forUsAccounts, onUsAccounts, payrollEmployees, hiddenKeys]);

  const visibleForUsTotal = visibleForUs.reduce((s, a) => s + a.value, 0);
  const visibleOnUsTotal = visibleOnUs.reduce((s, a) => s + a.value, 0) + visiblePayrollTotal;
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
            {hiddenShownCount > 0 && (
              <Button size="sm" variant="outline" onClick={showAll} data-testid="button-show-all-accounts">
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                Show all ({hiddenShownCount} hidden)
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
            {forUsAccounts.map((a, index) => {
              const key = rowVisibilityKey("forUs", a, index, forUsAccounts);
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
                  <span
                    className={`shrink-0 whitespace-nowrap font-mono tabular-nums ${hidden ? "text-muted-foreground" : "text-green-600"}`}
                  >
                    {formatAmount(a.value)}
                  </span>
                </button>
              );
            })}
            <div className="flex justify-between items-center px-3 py-2 rounded-md bg-green-50 dark:bg-green-950/30 mt-1">
              <span className="text-xs font-semibold text-green-700 dark:text-green-300">Visible subtotal</span>
              <span className="shrink-0 whitespace-nowrap font-mono font-bold text-green-600">
                {formatAmount(visibleForUsTotal)}
              </span>
            </div>
          </div>

          {/* What We Owe */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 mb-2">
              <Minus className="h-3.5 w-3.5 text-red-600 shrink-0" />
              <span className="text-xs font-semibold text-red-600 uppercase tracking-wide">What We Owe</span>
            </div>

            {payrollRow && !payrollMatchesReport && (isPayrollError || !!payrollData) && (
              <p role="status" className="text-xs text-amber-700 dark:text-amber-300 px-3 py-1">
                Employee breakdown unavailable or inconsistent for this date; Payroll Payable is shown as one reconciled
                account.
              </p>
            )}
            {/* Regular onUs account rows */}
            {onUsAccounts.map((a, index) => {
              const key = rowVisibilityKey("onUs", a, index, onUsAccounts);
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
                  <span
                    className={`shrink-0 whitespace-nowrap font-mono tabular-nums ${hidden ? "text-muted-foreground" : "text-red-600"}`}
                  >
                    {formatAmount(a.value)}
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
                      <span
                        className={`shrink-0 whitespace-nowrap font-mono tabular-nums ${hidden ? "text-muted-foreground" : "text-red-600"}`}
                      >
                        {formatAmount(emp.balance)}
                      </span>
                    </button>
                  );
                })}
              </>
            )}

            <div className="flex justify-between items-center px-3 py-2 rounded-md bg-red-50 dark:bg-red-950/30 mt-1">
              <span className="text-xs font-semibold text-red-700 dark:text-red-300">Visible subtotal</span>
              <span className="shrink-0 whitespace-nowrap font-mono font-bold text-red-600">
                {formatAmount(visibleOnUsTotal)}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
