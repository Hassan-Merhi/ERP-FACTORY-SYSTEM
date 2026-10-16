import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Package, Truck, DollarSign, Search, Eye, RefreshCw } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { SpContainerWithLines } from "@/pages/containers/types";

const trackingWords = {
  "en": {
    "refresh": "Refresh container tracking",
    "searchPlaceholder": "Search container #, PO or source…",
    "searchLabel": "Search open containers",
    "intro": "Open containers from Supplier Partner inventory, without duplicate ERP records",
    "loadFailed": "Failed to load Supplier Partner containers",
    "goodsOtw": "Goods OTW",
    "viewPO": "View PO",
    "loadError": "Unable to load Supplier Partner containers",
    "responseError": "Unexpected container response"
  },
  "fr": {
    "refresh": "Actualiser le suivi des conteneurs",
    "searchPlaceholder": "Rechercher un conteneur, une commande ou une source…",
    "searchLabel": "Rechercher parmi les conteneurs en transit",
    "intro": "Conteneurs ouverts de l'inventaire partenaire, sans duplicata ERP",
    "loadFailed": "Impossible de charger les conteneurs partenaires",
    "goodsOtw": "Marchandises en transit",
    "viewPO": "Voir la commande",
    "loadError": "Impossible de charger les conteneurs partenaires",
    "responseError": "Réponse de conteneurs inattendue"
  },
  "ar": {
    "refresh": "تحديث تتبع الحاويات",
    "searchPlaceholder": "ابحث برقم الحاوية أو الطلب أو المصدر…",
    "searchLabel": "البحث في الحاويات بالطريق",
    "intro": "الحاويات المفتوحة في مخزون الشريك دون سجلات مكررة في ERP",
    "loadFailed": "تعذر تحميل حاويات الشريك",
    "goodsOtw": "البضائع في الطريق",
    "viewPO": "عرض أمر الشراء",
    "loadError": "تعذر تحميل حاويات الشريك",
    "responseError": "استجابة غير متوقعة للحاويات"
  }
} as const;

function usd(value: string | number | null | undefined) {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number.isFinite(amount) ? amount : 0,
  );
}

/**
 * SP has its own source of truth (sp_containers), not the ERP GIT table.
 * This is an explicitly read-only tracking projection; importing or viewing
 * an SP container must never create a duplicate ERP container/voucher.
 */
export default function SupplierPartnerTrackingOTW() {
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const { language } = useApplicationLanguage();
  const copy = trackingWords[language];
  const [search, setSearch] = useState("");
  const companyId = selectedCompany?.id ?? null;
  const { data = [], isLoading, error, refetch } = useQuery<SpContainerWithLines[]>({
    queryKey: ["/api/sp/containers", companyId, "tracking-otw"],
    queryFn: async () => {
      const response = await fetch("/api/sp/containers", { credentials: "include" });
      if (!response.ok) throw new Error(copy.loadError);
      const result: unknown = await response.json();
      if (!Array.isArray(result)) throw new Error(copy.responseError);
      return result as SpContainerWithLines[];
    },
    enabled: companyId !== null && selectedCompany?.companyType === "supplier_partner",
    staleTime: 30_000,
  });
  const active = useMemo(() => data.filter((c) => c.status === "open"), [data]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term
      ? active.filter((c) => [c.containerNumber, c.invoiceNumber, c.supplierName].some((v) => String(v ?? "").toLowerCase().includes(term)))
      : active;
  }, [active, search]);
  const total = active.reduce((sum, c) => sum + Number(c.invoiceTotalUsd || 0), 0);

  return (
    <div className="flex flex-col h-full overflow-y-auto px-3 py-4 sm:px-0 space-y-4" data-testid="sp-tracking-otw">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">My Company · {selectedCompany?.name || "Supplier Partner"}</p>
          <p className="text-xs text-muted-foreground">{copy.intro}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} aria-label={copy.refresh}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : error ? (
        <div role="alert" className="rounded-lg border p-4 space-y-2">
          <p className="text-sm font-medium">{copy.loadFailed}</p>
          <p className="text-xs text-muted-foreground">{error instanceof Error ? error.message : "Please try again"}</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <div className="rounded-xl border bg-card p-3 flex items-center gap-3" data-testid="sp-tracking-active">
              <Package className="h-5 w-5 text-primary" />
              <div><p className="text-xs text-muted-foreground">Active</p><p className="text-lg font-semibold">{active.length}</p></div>
            </div>
            <div className="rounded-xl border bg-card p-3 flex items-center gap-3" data-testid="sp-tracking-total">
              <DollarSign className="h-5 w-5 text-green-600" />
              <div><p className="text-xs text-muted-foreground">Container Cost</p><p className="text-lg font-semibold">{usd(total)}</p></div>
            </div>
            <div className="rounded-xl border bg-card p-3 flex items-center gap-3">
              <Truck className="h-5 w-5 text-muted-foreground" />
              <div><p className="text-xs text-muted-foreground">Status</p><p className="text-sm font-semibold">{copy.goodsOtw}</p></div>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={copy.searchPlaceholder} aria-label={copy.searchLabel} />
          </div>
          <div className="rounded-xl border bg-card overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-3">Container #</th>
                  <th className="text-left px-3 py-3">PO Number</th>
                  <th className="text-left px-3 py-3">Source</th>
                  <th className="text-right px-3 py-3">Qty</th>
                  <th className="text-left px-3 py-3">Invoice Date</th>
                  <th className="text-right px-3 py-3">Cost (USD)</th>
                  <th className="text-left px-3 py-3">Status</th>
                  <th className="text-right px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30" data-testid={`tracking-sp-container-${c.id}`}>
                    <td className="px-3 py-3 font-semibold font-mono">{c.containerNumber || "—"}</td>
                    <td className="px-3 py-3">{c.invoiceNumber || "—"}</td>
                    <td className="px-3 py-3">{c.supplierName || "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{Number(c.totalQty || 0).toLocaleString("en-US")}</td>
                    <td className="px-3 py-3">{c.invoiceDate ? formatDisplayDate(String(c.invoiceDate)) : "—"}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">{usd(c.invoiceTotalUsd)}</td>
                    <td className="px-3 py-3"><Badge variant="outline" className="text-blue-600 border-blue-600/40">OTW</Badge></td>
                    <td className="px-3 py-3 text-right">
                      <Link href={`/containers/${c.id}`}>
                        <Button size="sm" variant="outline" data-testid={`button-tracking-view-sp-${c.id}`}><Eye className="h-4 w-4 mr-1" /> {copy.viewPO}</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={8} className="py-12 text-center text-muted-foreground">
                  {active.length === 0 ? "No active containers for this company" : "No matching containers"}
                </td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
