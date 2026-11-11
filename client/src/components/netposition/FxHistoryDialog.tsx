/**
 * FX Gain/Loss drill-down shared by ERP and Factory Net Position.
 * Calculated revaluation is not a journal; only persisted vouchers link to
 * the Voucher Detail page. Activity is read-only and company scoped.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, History, Info, RefreshCw } from "lucide-react";
import { companyQueryKey } from "@/lib/companyQueryScope";

export interface FxHistoryBreakdown {
  label: string;
  native?: string;
  usd: number;
  sourceKey?: string;
}

interface FxActivityEntry {
  id: string;
  kind: "voucher" | "rate" | "container" | "supplier_payment" | "supplier_transfer";
  date: string;
  recordedAt: string | null;
  reference: string;
  description: string;
  currency: string;
  nativeAmount: string | null;
  usdAmount: string | null;
  rate: string | null;
  voucherId: number | null;
  sourceKey: string | null;
}
interface FxActivityData {
  companyId: number;
  mode: "erp" | "factory";
  entries: FxActivityEntry[];
  truncated: boolean;
  notes: string[];
}
export interface FxHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "gain" | "loss";
  amount: number;
  sources?: FxHistoryBreakdown[];
  scope: "erp" | "factory";
  companyId?: number;
  asOf?: string;
}
const usd = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
const amountString = (amount: string | null) => {
  if (amount === null) return "—";
  const value = Number(amount);
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value) : "—";
};
const eventLabels: Record<FxActivityEntry["kind"], string> = {
  voucher: "Posted voucher",
  rate: "FX rate saved",
  container: "Supplier container",
  supplier_payment: "Supplier payment",
  supplier_transfer: "Supplier FX transfer",
};
function sourceLink(sourceKey: string | null | undefined, factory: boolean): string | null {
  if (!sourceKey) return null;
  const [kind, rawId] = sourceKey.split(":");
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (kind === "ledger") return `${factory ? "/factory" : ""}/ledger-monthly/${id}`;
  if (kind === "bank") return factory ? "/factory/accounts" : "/accounts";
  if (kind === "customer") return factory
    ? `/factory/parties?section=customers&customerId=${id}`
    : `/customers`;
  if (kind === "supplier") return factory
    ? `/factory/parties?section=suppliers&supplierId=${id}`
    : null;
  return null;
}

export function FxHistoryDialog({
  open, onOpenChange, side, amount, sources = [], scope, companyId, asOf,
}: FxHistoryDialogProps) {
  const [filter, setFilter] = useState<"all" | "voucher" | "rate" | "supplier">("all");
  const [relatedOnly, setRelatedOnly] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const factory = scope === "factory";
  const { data, isLoading, isFetching, error, refetch } = useQuery<FxActivityData>({
    queryKey: companyQueryKey("/api/accounts/multi-currency/fx-activity", companyId, scope, from, to),
    enabled: open && companyId != null,
    queryFn: async () => {
      const params = new URLSearchParams({ scope });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const response = await fetch(`/api/accounts/multi-currency/fx-activity?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const raw = await response.text();
        let message = raw;
        try { message = JSON.parse(raw)?.message || raw; } catch { /* plain response */ }
        throw new Error(message);
      }
      return response.json();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const entries = useMemo(() => {
    const keys = new Set(sources.map((source) => source.sourceKey).filter(Boolean));
    const currencies = new Set(
      sources.flatMap((source) => (source.native || "").toUpperCase().match(/\b[A-Z]{3}\b/g) || [])
    );
    return (data?.entries ?? []).filter((entry) => {
      if (filter === "supplier" && !["container", "supplier_payment", "supplier_transfer"].includes(entry.kind)) return false;
      if (filter !== "all" && filter !== "supplier" && entry.kind !== filter) return false;
      if (!relatedOnly || keys.size === 0) return true;
      if (entry.kind === "rate") return currencies.size === 0 || currencies.has(entry.currency);
      return entry.sourceKey != null && keys.has(entry.sourceKey);
    });
  }, [data?.entries, filter, relatedOnly, sources]);
  const title = side === "gain" ? "FX Gains" : "FX Losses";
  const amountColor = side === "gain"
    ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[96vw] max-w-6xl max-h-[92vh] flex flex-col overflow-hidden" data-testid="dialog-fx-history">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" /> {title} — Details & History
          </DialogTitle>
          <DialogDescription>
            Read-only exchange-rate valuation, with underlying accounting vouchers and saved-rate history.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto space-y-5 pr-1">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
            <div>
              <div className="text-xs uppercase text-muted-foreground">Current displayed unrealized {side}</div>
              <div className={`font-mono text-2xl font-bold ${amountColor}`} data-testid="fx-history-total">{usd(amount)}</div>
              {asOf && <div className="text-xs text-muted-foreground">Net Position as of {asOf}</div>}
            </div>
            <Badge variant="secondary">Reporting only · Not posted</Badge>
          </div>

          <section className="space-y-2" aria-label="FX gain loss source breakdown">
            <h3 className="font-semibold text-sm">Accounts contributing to this total</h3>
            {sources.length ? (
              <div className="rounded-md border divide-y">
                {sources.map((source, index) => {
                  const href = sourceLink(source.sourceKey, factory);
                  return (
                    <div key={`${source.label}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        {href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex gap-1 items-center font-medium hover:underline">
                            <span>{source.label}</span><ExternalLink className="h-3.5 w-3.5 shrink-0" />
                          </a>
                        ) : <span className="font-medium">{source.label}</span>}
                        {source.native && <div className="text-xs font-mono text-muted-foreground">{source.native}</div>}
                      </div>
                      <span className={`font-mono tabular-nums font-medium shrink-0 ${amountColor}`}>{usd(source.usd)}</span>
                    </div>
                  );
                })}
              </div>
            ) : <p className="text-sm text-muted-foreground">No itemized contribution is available for this report row.</p>}
          </section>

          <section className="space-y-3" aria-label="Foreign currency source activity history">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-semibold text-sm">Recorded FX activity history</h3>
                <p className="text-xs text-muted-foreground">Original vouchers, saved rate changes and supplier transactions — newest first</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching || !companyId}>
                <RefreshCw className="h-4 w-4 mr-1.5" /> Refresh
              </Button>
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <Button type="button" size="sm" variant={relatedOnly ? "secondary" : "outline"} onClick={() => setRelatedOnly((value) => !value)}
                data-testid="button-fx-related-only">
                {relatedOnly ? "Related accounts" : "All company activity"}
              </Button>
              {(["all", "voucher", "rate", "supplier"] as const).filter((kind) => factory || kind !== "supplier").map((kind) => (
                <Button key={kind} type="button" size="sm" variant={filter === kind ? "secondary" : "outline"} onClick={() => setFilter(kind)}>
                  {kind === "all" ? "All activity" : kind === "voucher" ? "Vouchers" : kind === "rate" ? "FX rates" : "Suppliers"}
                </Button>
              ))}
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
                From <Input type="date" className="w-[150px] h-8" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                To <Input type="date" className="w-[150px] h-8" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
            {isLoading ? (
              <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
            ) : error ? (
              <div role="alert" className="border border-destructive/40 rounded-md p-3 text-sm text-destructive">
                Could not load FX history: {(error as Error).message}
              </div>
            ) : data?.companyId !== companyId || data?.mode !== scope ? (
              <div role="alert" className="text-sm text-destructive">History company context does not match the displayed Net Position.</div>
            ) : (
              <>
                <div className="border rounded-md overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-muted/50 text-muted-foreground text-xs">
                      <tr>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Type / Reference</th>
                        <th className="px-3 py-2">Description</th>
                        <th className="px-3 py-2">Currency</th>
                        <th className="px-3 py-2 text-right">Native amount</th>
                        <th className="px-3 py-2 text-right">Book USD</th>
                        <th className="px-3 py-2 text-right">Recorded rate</th>
                        <th className="px-3 py-2 text-right">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {entries.map((entry) => {
                        const voucherHref = entry.voucherId
                          ? `${factory ? "/factory" : ""}/voucher-detail/${entry.voucherId}`
                          : null;
                        const sourceHref = sourceLink(entry.sourceKey, factory);
                        return (
                          <tr key={entry.id} data-testid={`row-fx-event-${entry.id}`} className="hover:bg-muted/20">
                            <td className="px-3 py-2 whitespace-nowrap font-mono">{entry.date}</td>
                            <td className="px-3 py-2">
                              <Badge variant="outline" className="text-[10px] mb-1">{eventLabels[entry.kind]}</Badge>
                              <div className="font-medium max-w-[200px] break-words">{entry.reference}</div>
                            </td>
                            <td className="px-3 py-2 max-w-[250px] break-words text-muted-foreground">{entry.description}</td>
                            <td className="px-3 py-2 font-mono">{entry.currency}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{amountString(entry.nativeAmount)}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{amountString(entry.usdAmount)}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{amountString(entry.rate)}</td>
                            <td className="px-3 py-2 text-right">
                              {(voucherHref || sourceHref) ? (
                                <a href={voucherHref || sourceHref || "#"} target="_blank" rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-primary hover:underline">
                                  {voucherHref ? "Voucher" : "Source"} <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : <span className="text-muted-foreground">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!entries.length && <div className="py-8 text-center text-sm text-muted-foreground">
                    No recorded activity for these filters. Choose All company activity to browse other foreign-currency records.
                  </div>}
                </div>
                {data?.truncated && <p className="text-xs text-amber-700 dark:text-amber-400">Showing the latest 300 history entries. Set a shorter From/To range to inspect older records.</p>}
              </>
            )}
          </section>
          <div className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <p>FX gains and losses shown in Net Position are calculated from the current monetary exposure, not journal vouchers. This history lists the recorded transactions and exchange rates behind those balances; it does not fabricate daily gain/loss postings. Original vouchers remain unchanged.</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
