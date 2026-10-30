import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Coins, Loader2, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { isBonusCategoryDate, parseBonusCategoryRate } from "@shared/productionTargetBonusCategoryRates";

interface CategoryRate {
  id: number; categoryKey: string; categoryLabel: string;
  effectiveFrom: string; enabled: boolean; ratePerExtraBale: string;
  note?: string | null; createdAt?: string;
}
interface CategoryResponse {
  currency: string;
  categories: Array<{ categoryKey: string; categoryLabel: string; effective: CategoryRate | null }>;
  history: CategoryRate[];
  historyTruncated: boolean;
  configuredForPayments: boolean;
}

const endpoint = "/api/factory/production-target-bonuses/category-rates";
async function api<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, url, body);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Category bonus settings request failed");
  }
  return response.json() as Promise<T>;
}

/** Only mounted inside the admin/owner Production Bonuses view. This configures
 * future category bonus rules; it does not modify existing reviewed payments.
 */
export function ProductionBonusCategoryRatesPanel({ initialDate }: { initialDate: string }) {
  const { toast } = useToast();
  const [asOf, setAsOf] = useState(initialDate);
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(initialDate);
  const [rate, setRate] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [note, setNote] = useState("");
  const [requestKey, setRequestKey] = useState("");
  useEffect(() => setAsOf(initialDate), [initialDate]);

  const { data, isLoading, error } = useQuery<CategoryResponse>({
    queryKey: [endpoint, asOf],
    enabled: isBonusCategoryDate(asOf),
    queryFn: () => api("GET", endpoint + "?" + new URLSearchParams({ asOf })),
  });
  function openEditor(label = "", current: CategoryRate | null = null) {
    setCategory(label);
    setEffectiveFrom(initialDate);
    setRate(current?.ratePerExtraBale ?? "");
    setEnabled(current?.enabled ?? true);
    setNote("");
    setRequestKey(crypto.randomUUID());
    setEditing(true);
  }
  const save = useMutation({
    mutationFn: () => api("POST", endpoint, {
      category, effectiveFrom, enabled, ratePerExtraBale: rate,
      note, requestKey,
    }),
    onSuccess: () => {
      setEditing(false);
      toast({ title: "Category rate saved", description: "Saved as an effective-dated rate version. Existing bonus payments are unchanged." });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
    },
    onError: (cause: Error) => toast({ title: "Category rate not saved", description: cause.message, variant: "destructive" }),
  });
  const validRate = parseBonusCategoryRate(rate);
  const canSave = Boolean(category.trim()) && isBonusCategoryDate(effectiveFrom) &&
    validRate !== null && (!enabled || Number(validRate) > 0) &&
    !save.isPending;

  return (
    <details className="rounded-lg border bg-muted/10" data-testid="production-bonus-category-rates">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        <Coins className="mr-2 inline h-4 w-4" /> Category rates — Bags, Toys, Shoes and more
      </summary>
      <div className="space-y-3 border-t px-4 py-4">
        <p className="text-xs text-muted-foreground">
          Set a different USD amount per extra bale for each category. Rates are saved by effective date.
          Allocating targets and production when a worker switches categories is handled separately;
          these saved rates do not change existing approvals or post money.
        </p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            Rates on date
            <Input aria-label="Category bonus rates as of" type="date" value={asOf}
              onChange={event => setAsOf(event.target.value)} className="w-[165px]" />
          </label>
          <Button type="button" size="sm" variant="outline" onClick={() => openEditor()}>
            <Plus className="mr-1.5 h-4 w-4" /> Add category rate
          </Button>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
        {!isBonusCategoryDate(asOf) && <p role="alert" className="text-sm text-destructive">Choose a valid date.</p>}
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Rate / extra bale</th>
                <th className="px-3 py-2">Effective from</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Edit</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                <Loader2 className="mr-1.5 inline h-4 w-4 animate-spin" /> Loading category rates…
              </td></tr>}
              {data?.categories.map(item => (
                <tr className="border-t" key={item.categoryKey}>
                  <td className="px-3 py-2 font-medium">{item.categoryLabel}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {item.effective ? "$" + item.effective.ratePerExtraBale : "Not set"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{item.effective?.effectiveFrom ?? "—"}</td>
                  <td className="px-3 py-2">{!item.effective ? "Unconfigured" : item.effective.enabled ? "Enabled" : "Disabled"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button type="button" size="sm" variant="ghost" aria-label={"Edit rate for " + item.categoryLabel}
                      onClick={() => openEditor(item.categoryLabel, item.effective)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {!isLoading && data && data.categories.length === 0 && <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                  No production categories yet. Add a named category to configure its rate.
                </td>
              </tr>}
            </tbody>
          </table>
        </div>
        {data && data.history.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Rate change history ({data.history.length}{data.historyTruncated ? "+" : ""})</summary>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {data.history.map(version => <div key={version.id} className="flex flex-wrap justify-between gap-3 border-b py-1">
                <span>{version.categoryLabel} · from {version.effectiveFrom}</span>
                <span className="tabular-nums">{version.enabled ? "$" + version.ratePerExtraBale : "Disabled"}</span>
              </div>)}
            </div>
          </details>
        )}
        <Dialog open={editing} onOpenChange={open => { if (!open) setEditing(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Category bonus rate</DialogTitle>
              <DialogDescription>
                Save the amount for this category from the selected date forward.
                Previous saved versions and reviewed bonuses remain unchanged.
              </DialogDescription>
            </DialogHeader>
            <label className="space-y-1 text-sm">Category
              <Input aria-label="Production bonus category" value={category} maxLength={100}
                onChange={event => setCategory(event.target.value)} placeholder="e.g. Bags or Toys" />
            </label>
            <label className="space-y-1 text-sm">Effective from
              <Input aria-label="Category rate effective from" type="date" value={effectiveFrom}
                onChange={event => setEffectiveFrom(event.target.value)} />
            </label>
            <label className="space-y-1 text-sm">Amount per extra bale (USD)
              <Input aria-label="Category rate USD per extra bale" type="number"
                min="0" max="10000" step="0.0001" value={rate}
                onChange={event => setRate(event.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={value => setEnabled(value === true)} />
              Enabled
            </label>
            <label className="space-y-1 text-sm">Reason / note (optional)
              <Input aria-label="Category rate note" value={note} maxLength={500}
                onChange={event => setNote(event.target.value)} />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="button" disabled={!canSave} onClick={() => save.mutate()}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save dated rate
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </details>
  );
}
