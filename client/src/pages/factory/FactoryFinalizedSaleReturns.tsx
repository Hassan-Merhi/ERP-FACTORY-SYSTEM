import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Invoice = { id: number; invoiceNumber: string; containerNumber: string | null;
  customerName: string | null; grandTotal: string; quantity: number };
type Bale = { baleId: number; referenceNumber: string; articleCode: string | null;
  productName: string | null; priceUsed: string; weightKg: string; status: string };
type Detail = { order: { id: number; invoiceNumber: string; containerNumber: string | null;
  grandTotal: string; totalQtyBales: number }; bales: Bale[]; blockedReason: string | null };
type ReturnHistory = { returnBatch: string; invoiceNumber: string; containerNumber: string | null;
  articleCode: string | null; productName: string | null; quantity: number;
  baleReferences: string; returnedAt: string; returnedBy: string; reason: string };
type ApplyResult = { invoiceNumber: string; quantity: number; customerCredit: string;
  snapshotUpdated: boolean; warning: string | null };
const api = "/api/factory/finalized-sale-returns";
async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || "Could not complete request");
  return value as T;
}
const fmt = (value: string | number) => Number(value || 0).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function FactoryFinalizedSaleReturns() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [orderId, setOrderId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);

  useEffect(() => {
    setOrderId(null); setSelected([]); setSearch(""); setReason("");
    setConfirmed(false); setResult(null);
  }, [selectedCompany?.id]);

  const { data: invoices = [] } = useQuery<Invoice[]>({
    queryKey: companyQueryKey(api + "/orders", selectedCompany?.id, search),
    queryFn: () => read(api + "/orders?search=" + encodeURIComponent(search)),
    enabled: !!selectedCompany?.id,
  });
  const { data: detail } = useQuery<Detail>({
    queryKey: companyQueryKey(api + "/orders/" + orderId, selectedCompany?.id),
    queryFn: () => read(api + "/orders/" + orderId),
    enabled: !!selectedCompany?.id && orderId !== null,
  });
  const { data: history = [] } = useQuery<ReturnHistory[]>({
    queryKey: companyQueryKey(api + "/history", selectedCompany?.id),
    queryFn: () => read(api + "/history"),
    enabled: !!selectedCompany?.id,
  });

  const groups = useMemo(() => {
    const byArticle = new Map<string, { name: string; code: string; bales: Bale[] }>();
    for (const bale of detail?.bales ?? []) {
      const code = bale.articleCode || "Uncoded";
      const name = bale.productName || code;
      const key = code + ":" + name;
      const group = byArticle.get(key) || { code, name, bales: [] };
      group.bales.push(bale); byArticle.set(key, group);
    }
    return [...byArticle.values()];
  }, [detail?.bales]);
  const chosen = detail?.bales.filter(b => selected.includes(b.baleId)) ?? [];
  const priced = chosen.reduce((value, bale) => value + Number(bale.priceUsed || 0), 0);

  const mutation = useMutation({
    mutationFn: () => read<ApplyResult>(api + "/apply", { method: "POST", body: JSON.stringify({
      orderId, baleIds: selected, reason, confirmReturn: confirmed,
      expectedTotal: detail?.order.grandTotal,
    }) }),
    onSuccess: response => {
      setResult(response); setSelected([]); setReason(""); setConfirmed(false);
      queryClient.invalidateQueries({ queryKey: [api + "/orders"] });
      queryClient.invalidateQueries({ queryKey: [api + "/history"] });
      queryClient.invalidateQueries({ queryKey: [api + "/orders/" + orderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      toast({ title: "Return posted", description: response.quantity + " bales removed from finalized invoice" });
    },
    onError: (e: Error) => toast({ title: "Return blocked", description: e.message, variant: "destructive" }),
  });
  const toggleBale = (id: number, checked: boolean) =>
    setSelected(old => checked ? [...new Set([...old, id])] : old.filter(x => x !== id));

  return (
    <div className="space-y-5" data-testid="finalized-sale-returns">
      <div>
        <h2 className="text-lg font-semibold">Finalized Loading Sale Returns</h2>
        <p className="text-sm text-muted-foreground">Return physical bales from regular finalized customer container loadings.
          This changes the original invoice amount, customer receivable, COGS and available stock together.
          It does not touch Factory POS or posted dispatch-trip invoices.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="return-invoice-search">Search invoice / container / customer</Label>
        <Input id="return-invoice-search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Enter invoice, container number or customer" />
        <div className="max-h-48 overflow-auto rounded border">
          {invoices.length === 0 && <p className="p-3 text-sm text-muted-foreground">No finalized loading found.</p>}
          {invoices.map(invoice => (
            <button key={invoice.id} type="button" onClick={() => {
              setOrderId(invoice.id); setSelected([]); setConfirmed(false); setResult(null);
            }} className={"flex w-full justify-between gap-2 border-b p-3 text-left text-sm hover:bg-muted " +
              (invoice.id === orderId ? "bg-muted font-semibold" : "")}>
              <span>{invoice.invoiceNumber} · {invoice.containerNumber || "No container"} · {invoice.customerName || "Customer"}</span>
              <span className="shrink-0">{invoice.quantity} bales · {fmt(invoice.grandTotal)}</span>
            </button>
          ))}
        </div>
      </div>

      {detail && (
        <div className="space-y-4 rounded border p-4">
          <h3 className="font-semibold">{detail.order.invoiceNumber} · {detail.order.containerNumber || "No container"}</h3>
          <p className="text-sm">Current invoice total: {fmt(detail.order.grandTotal)} · {detail.order.totalQtyBales} bales</p>
          {detail.blockedReason && <p className="font-semibold text-destructive">{detail.blockedReason}</p>}
          {groups.map(group => {
            const available = group.bales.filter(b => ["SOLD", "IN_STOCK"].includes(b.status));
            const all = available.length > 0 && available.every(b => selected.includes(b.baleId));
            return <div key={group.code + group.name} className="rounded border">
              <label className="flex items-center gap-2 bg-muted/40 p-3 text-sm font-semibold">
                <Checkbox checked={all} disabled={!!detail.blockedReason || available.length === 0}
                  onCheckedChange={checked => setSelected(old => checked
                    ? [...new Set([...old, ...available.map(b => b.baleId)])]
                    : old.filter(id => !available.some(b => b.baleId === id)))} />
                {group.name} · {group.code} · {group.bales.length} on invoice
                <span className="ml-auto">{available.filter(b => selected.includes(b.baleId)).length} selected</span>
              </label>
              {group.bales.map(bale => (
                <label key={bale.baleId} className="flex cursor-pointer flex-wrap items-center gap-3 border-t p-2 text-sm">
                  <Checkbox checked={selected.includes(bale.baleId)}
                    disabled={!!detail.blockedReason || !["SOLD","IN_STOCK"].includes(bale.status)}
                    onCheckedChange={checked => toggleBale(bale.baleId,checked===true)} />
                  <strong>{bale.referenceNumber}</strong>
                  <span>{fmt(bale.priceUsed)} · {bale.weightKg} kg</span>
                  <span className="ml-auto text-muted-foreground">
                    {bale.status === "IN_STOCK" ? "Already physically in stock" : bale.status}
                  </span>
                </label>
              ))}
            </div>;
          })}
          <p className="text-sm"><strong>{chosen.length}</strong> bales selected · historic bale-price total {fmt(priced)}.
            The posted invoice reduction is recalculated using the original per-bale or per-kg pricing.</p>
          <Label htmlFor="return-sale-reason">Reason</Label>
          <Textarea id="return-sale-reason" rows={2} value={reason}
            onChange={e => setReason(e.target.value)} placeholder="Why were these bales returned?" />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={confirmed} onCheckedChange={v => setConfirmed(v === true)} />
            These exact bales were physically returned; adjust the invoice, customer balance and journals.
          </label>
          <Button onClick={() => mutation.mutate()} disabled={
            !!detail.blockedReason || chosen.length===0 || reason.trim().length<5 || !confirmed || mutation.isPending}>
            {mutation.isPending ? "Applying return…" : "Return selected bales and adjust invoice"}
          </Button>
          {result && <p className="text-sm" role="status">
            Posted {result.quantity} returned bales · invoice reduced by {fmt(result.customerCredit)}.
            {result.warning && <span className="block text-destructive">{result.warning}</span>}
          </p>}
        </div>
      )}

      <div className="space-y-2 border-t pt-4">
        <h3 className="font-semibold">Return history</h3>
        <div className="overflow-x-auto rounded border">
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead><tr className="bg-muted/40">
              <th className="p-2">Date / Invoice</th><th className="p-2">Name</th>
              <th className="p-2">Article code</th><th className="p-2">Total qty removed</th>
              <th className="p-2">Bale references</th><th className="p-2">User / Reason</th>
            </tr></thead>
            <tbody className="divide-y">
              {history.map((row,index)=><tr key={row.returnBatch+row.articleCode+index}>
                <td className="p-2">{new Date(row.returnedAt).toLocaleString()}<div>
                  {row.invoiceNumber} / {row.containerNumber}</div></td>
                <td className="p-2">{row.productName}</td><td className="p-2">{row.articleCode}</td>
                <td className="p-2 font-semibold">{row.quantity}</td><td className="p-2">{row.baleReferences}</td>
                <td className="p-2">{row.returnedBy}<div className="text-muted-foreground">{row.reason}</div></td>
              </tr>)}
              {history.length === 0 && <tr><td className="p-3 text-muted-foreground" colSpan={6}>No returns recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
