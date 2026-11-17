/**
 * Golden Coast operations — shared presentation and request helpers.
 *
 * The phase panels each own their own state, readiness query, and mutation.
 * Everything they have in common — amount gating, account pickers, readiness
 * banners, and cache invalidation — lives here so no panel re-implements it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { formatUsd } from "@/lib/moneyDisplay";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { apiRequest } from "@/lib/queryClient";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CashAccountKind, CashAccountOption } from "./contracts";

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function previousCompletedMonth(): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

export function makeRequestId(prefix: string): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2);
  return `${prefix}:${Date.now()}:${randomPart}`.slice(0, 64);
}

export function money(value: unknown): string {
  const amount = Number(value ?? 0);
  const normalized = Number.isFinite(amount) ? amount : 0;
  return formatUsd(normalized, 2);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return releaseDebtEnglish("The request failed. Refresh readiness and try again.");
}

export function accountKey(account: Pick<CashAccountOption, "kind" | "id">): string {
  return `${account.kind}:${account.id}`;
}

export function selectedAccount(
  value: string,
  accounts: CashAccountOption[]
): { kind: CashAccountKind; id: number } | null {
  const fallback = accounts[0];
  const match = accounts.find((account) => accountKey(account) === value) ?? fallback;
  return match ? { kind: match.kind, id: match.id } : null;
}

/** A submitted amount must be positive and within the server-reported cap. */
export function allowedAmount(value: string, maximum: unknown): boolean {
  const amount = Number(value);
  const cap = Number(maximum);
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(cap) && cap >= amount;
}

export async function readJson<T>(url: string): Promise<T> {
  const response = await apiRequest("GET", url);
  return (await response.json()) as T;
}

/**
 * Drop every cached Golden Coast readiness payload plus the SP sales list, so
 * balances shown after a posting are re-read from the server rather than
 * recomputed on the client.
 */
export function useReadinessInvalidation(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/sp/golden-coast/"),
    });
    void queryClient.invalidateQueries({ queryKey: ["/api/sp/sales"] });
  };
}

export function AccountPicker({
  id,
  value,
  accounts,
  onChange,
}: {
  id: string;
  value: string;
  accounts: CashAccountOption[];
  onChange: (value: string) => void;
}) {
  const effectiveValue = value || (accounts[0] ? accountKey(accounts[0]) : "");
  return (
    <Select value={effectiveValue || "__none__"} onValueChange={(next) => onChange(next === "__none__" ? "" : next)}>
      <SelectTrigger id={id} className="h-10 w-full text-sm" data-testid={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {accounts.length === 0 ? (
          <SelectItem value="__none__">{releaseDebtEnglish("No active cash or bank accounts")}</SelectItem>
        ) : (
          accounts.map((account) => (
            <SelectItem key={accountKey(account)} value={accountKey(account)}>
              {account.name} · {account.type ?? account.kind}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

export function ReadinessState({
  loading,
  error,
  ready,
  readyText,
  blockedText,
}: {
  loading: boolean;
  error: unknown;
  ready: boolean;
  readyText: string;
  blockedText: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {releaseDebtEnglish("Checking live readiness…")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <span>{errorMessage(error)}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border p-3 text-sm">
      {ready ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <span>{ready ? readyText : blockedText}</span>
    </div>
  );
}
