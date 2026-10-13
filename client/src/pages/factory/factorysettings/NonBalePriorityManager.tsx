import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { factoryApiRequest } from "@/lib/factoryApi";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Product = { id: number; code: string; articleCode: string | null; name: string; weightKg: string | null };
type Selection = { selectedIds: number[]; products: Product[]; canEdit: boolean };
const URL = "/api/factory/non-bale-priority-items";

export function NonBalePriorityManager() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const companyId = selectedCompany?.id ?? null;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [minKg, setMinKg] = useState("");
  const [maxKg, setMaxKg] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const {data, isPending, isError, refetch} = useQuery<Selection>({
    queryKey: companyQueryKey(URL, companyId),
    queryFn: async () => {
      const response = await factoryApiRequest("GET", URL);
      if (!response.ok) throw new Error("Unable to load non-bale items");
      return response.json();
    },
    enabled: open && companyId !== null,
    refetchOnWindowFocus: false,
  });
  useEffect(() => { if (data && !dirty) setSelected(data.selectedIds); }, [data, dirty]);
  useEffect(() => { setOpen(false); setSelected([]); setDirty(false); }, [companyId]);
  const products = data?.products ?? [];
  const filtered = useMemo(() => products.filter(item => {
    const q = search.trim().toLowerCase();
    const weight = Number(item.weightKg);
    return (!q || [item.name, item.code, item.articleCode ?? ""].some(v => v.toLowerCase().includes(q)))
      && (!minKg || (item.weightKg !== null && weight >= Number(minKg)))
      && (!maxKg || (item.weightKg !== null && weight <= Number(maxKg)));
  }), [products, search, minKg, maxKg]);
  const change = (ids: number[]) => { setSelected([...new Set(ids)]); setDirty(true); };

  return <>
    <Button type="button" variant="outline" onClick={() => setOpen(true)}>Manage Non-Bale Priority Items</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Non-Bale Priority Items</DialogTitle>
          <DialogDescription>Permanent saved exclusions. These products print normally but are not automatically loaded or entered into Priority, Daily, or Ground Scan.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input placeholder="Search name or code" value={search} onChange={e => setSearch(e.target.value)} />
          <Input type="number" min="0" placeholder="Minimum KG" value={minKg} onChange={e => setMinKg(e.target.value)} />
          <Input type="number" min="0" placeholder="Maximum KG" value={maxKg} onChange={e => setMaxKg(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!data?.canEdit} onClick={() => change(products.map(i => i.id))}>Select All</Button>
          <Button size="sm" variant="outline" disabled={!data?.canEdit} onClick={() => change([...selected, ...filtered.map(i => i.id)])}>Select All Filtered ({filtered.length})</Button>
          <Button size="sm" variant="outline" disabled={!data?.canEdit} onClick={() => change(selected.filter(id => !filtered.some(i => i.id === id)))}>Deselect Filtered</Button>
          <span className="text-sm text-muted-foreground">{selected.length} selected</span>
        </div>
        {isPending ? <p>Loading items…</p> : isError ? <Button onClick={() => void refetch()}>Retry</Button> : (
          <div className="border rounded-md max-h-[45vh] overflow-y-auto divide-y">
            {filtered.map(item => (
              <label key={item.id} className="flex items-center gap-3 p-2 cursor-pointer">
                <input type="checkbox" disabled={!data?.canEdit} checked={selected.includes(item.id)} onChange={e => change(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
                <span className="flex-1 text-sm">{item.name} <span className="text-muted-foreground">({item.articleCode || item.code})</span></span>
                <span className="text-sm">{item.weightKg ?? "—"} KG</span>
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button disabled={!dirty || saving || !data?.canEdit} onClick={async () => {
            setSaving(true);
            try {
              const response = await factoryApiRequest("PUT", URL, { selectedIds: selected });
              if (!response.ok) throw new Error((await response.json().catch(() => ({ message: "Save failed" }))).message || "Save failed");
              setDirty(false);
              toast({ title: "Non-bale items saved permanently" });
              await refetch();
            } catch (error) {
              toast({ title: "Unable to save non-bale items", description: String(error), variant: "destructive" });
            } finally { setSaving(false); }
          }}>{saving ? "Saving…" : "Save Changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
