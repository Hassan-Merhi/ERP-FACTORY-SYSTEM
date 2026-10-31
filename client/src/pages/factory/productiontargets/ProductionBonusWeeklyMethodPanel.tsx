import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import {
  mondayOfProductionBonusWeek, parseTypedProductionBonusDate, parseWeeklyFlatBonusUsd,
  type ProductionBonusMethod,
} from "@shared/productionTargetBonusWeeklyMethod";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";

interface MethodVersion {
  id: number | null; method: ProductionBonusMethod; flatBonusUsd: string;
  effectiveWeek: string | null; note?: string | null;
  createdAt?: string; createdBy?: string;
}
interface SettingsResponse {
  currency: "USD"; weekStart: string; effective: MethodVersion;
  history: MethodVersion[]; historyTruncated: boolean;
  configuredForPayments: false;
}
const endpoint = "/api/factory/production-target-bonuses/weekly-method";
async function api<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, url, body);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.message || "Could not save weekly bonus settings");
  }
  return response.json() as Promise<T>;
}

/** Phase 12 method selection is settings-only; no weekly payment is enabled here. */
export function ProductionBonusWeeklyMethodPanel({ initialDate }: { initialDate: string }) {
  const { toast } = useToast();
  const [asOf, setAsOf] = useState(initialDate);
  const [editing, setEditing] = useState(false);
  const [effectiveWeek, setEffectiveWeek] = useState(mondayOfProductionBonusWeek(initialDate) ?? "");
  const [method, setMethod] = useState<ProductionBonusMethod>("per_extra_bale");
  const [flatBonusUsd, setFlatBonusUsd] = useState("0.00");
  const [note, setNote] = useState("");
  const [requestKey, setRequestKey] = useState("");
  useEffect(() => setAsOf(initialDate), [initialDate]);

  const { data, isLoading, error } = useQuery<SettingsResponse>({
    queryKey: [endpoint, asOf],
    enabled: isBonusCategoryDate(asOf),
    queryFn: () => api("GET", endpoint + "?" + new URLSearchParams({ asOf }).toString()),
  });

  function openEditor() {
    setMethod(data?.effective.method ?? "per_extra_bale");
    setFlatBonusUsd(data?.effective.method === "weekly_flat"
      ? (data.effective.flatBonusUsd || "") : "0.00");
    setEffectiveWeek(mondayOfProductionBonusWeek(asOf) ?? "");
    setNote("");
    setRequestKey(crypto.randomUUID());
    setEditing(true);
  }
  const save = useMutation({
    mutationFn: () => api("POST", endpoint, {
      effectiveWeek: mondayOfProductionBonusWeek(parseTypedProductionBonusDate(effectiveWeek)), method,
      flatBonusUsd: method === "per_extra_bale" ? "0.00" : flatBonusUsd,
      note, requestKey,
    }),
    onSuccess: () => {
      setEditing(false);
      toast({ title: "Weekly bonus method saved", description: "New effective-week version saved. Existing bonus approvals and payments are unchanged." });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/weekly-preview"] });
    },
    onError: (cause: Error) =>
      toast({ title: "Weekly method not saved", description: cause.message, variant: "destructive" }),
  });
  const parsedAmount = parseWeeklyFlatBonusUsd(flatBonusUsd);
  const enteredWeekDate = parseTypedProductionBonusDate(effectiveWeek);
  const beginningMonday = mondayOfProductionBonusWeek(enteredWeekDate);
  const canSave = beginningMonday !== null &&
    (method === "per_extra_bale" || (parsedAmount !== null && Number(parsedAmount) > 0)) &&
    !save.isPending;

  return (
    <details className="rounded-lg border bg-muted/10" data-testid="production-bonus-weekly-method">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        <CalendarDays className="mr-2 inline h-4 w-4" /> Weekly bonus method — per bale or flat fee
      </summary>
      <div className="space-y-3 border-t px-4 py-4">
        <p className="text-xs text-muted-foreground">
          Choose how future Production Targets bonuses should work. The weekly flat method pays
          once per eligible worker per week when credited bales exceed that worker's weekly target,
          regardless of whether the worker made 1 or 30 extra bales.
          Weekly eligibility, immutable approvals, and payment posting are handled in the dedicated review and payment sections.
        </p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            View settings on date
            <Input aria-label="Weekly bonus settings as of" type="date" value={asOf}
              onChange={event => setAsOf(event.target.value)} className="w-[165px]" />
          </label>
          <Button type="button" size="sm" variant="outline" onClick={openEditor}
            disabled={!data}>
            <Pencil className="mr-1.5 h-4 w-4" /> Set method / flat fee
          </Button>
        </div>
        {!isBonusCategoryDate(asOf) && <p role="alert" className="text-sm text-destructive">Choose a valid date.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
        {isLoading && <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading...</p>}
        {data && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background p-3">
            <div>
              <p className="text-xs text-muted-foreground">Configured method for week starting {data.weekStart}</p>
              <p className="font-semibold">{data.effective.method === "weekly_flat"
                ? "Weekly flat bonus" : "Per extra bale (existing)"}</p>
              <p className="text-sm text-muted-foreground">
                {data.effective.method === "weekly_flat"
                  ? "$" + data.effective.flatBonusUsd + " per eligible worker/week"
                  : "Existing per-extra-bale and category rates remain separate"}
              </p>
            </div>
            <span className="rounded-full border px-2 py-1 text-xs text-muted-foreground">
              Settings only · no voucher on save
            </span>
          </div>
        )}
        {data && data.history.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Saved method history ({data.history.length}{data.historyTruncated ? "+" : ""})
            </summary>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {data.history.map(version => (
                <div key={version.id} className="flex flex-wrap justify-between gap-3 border-b py-1">
                  <span>Week of {version.effectiveWeek} · {version.method === "weekly_flat"
                    ? "Weekly flat" : "Per extra bale"}</span>
                  <span className="tabular-nums">{version.method === "weekly_flat"
                    ? "$" + version.flatBonusUsd : "Existing rates"}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        <Dialog open={editing} onOpenChange={open => { if (!open) setEditing(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Weekly Production Targets bonus method</DialogTitle>
              <DialogDescription>
                Saved by Monday–Sunday week. This choice determines which new bonus review method is allowed for that week. Previously approved amounts, payments and vouchers remain unchanged.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1 text-sm">
              <label htmlFor="bonus-week-manual-date">Week beginning (Monday)</label>
              <div className="flex items-center gap-2">
                <Input id="bonus-week-manual-date" aria-label="Type bonus week date"
                  type="text" inputMode="numeric" maxLength={10}
                  placeholder="YYYY-MM-DD or MM/DD/YYYY" value={effectiveWeek}
                  onChange={event => setEffectiveWeek(event.target.value)}
                  onBlur={() => {
                    if (beginningMonday) setEffectiveWeek(beginningMonday);
                  }} />
                <Input aria-label="Choose bonus week date from calendar"
                  type="date" className="w-[155px] shrink-0"
                  value={enteredWeekDate ?? ""}
                  onChange={event => setEffectiveWeek(event.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">
                Type YYYY-MM-DD or MM/DD/YYYY, or choose a date. The week begins on Monday.
              </p>
            </div>
            <label className="space-y-1 text-sm">
              Bonus calculation method
              <Select value={method} onValueChange={value => setMethod(value as ProductionBonusMethod)}>
                <SelectTrigger aria-label="Bonus calculation method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_extra_bale">Per extra bale (existing)</SelectItem>
                  <SelectItem value="weekly_flat">Weekly flat bonus (new)</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {method === "weekly_flat" && (
              <label className="space-y-1 text-sm">
                Fixed bonus per eligible worker/week (USD)
                <Input aria-label="Weekly flat bonus USD" type="number"
                  min="0.01" max="100000" step="0.01"
                  value={flatBonusUsd} onChange={event => setFlatBonusUsd(event.target.value)} />
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              Example: target 56, produced 57 or 90 = same fixed weekly bonus.
              Exactly 56 does not qualify. The weekly approval flow does not post a payment.
            </p>
            <label className="space-y-1 text-sm">
              Change note (optional)
              <Input aria-label="Weekly bonus method note" value={note} maxLength={500}
                onChange={event => setNote(event.target.value)} />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="button" disabled={!canSave} onClick={() => save.mutate()}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save week setting
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </details>
  );
}
