import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Palette, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Load = { id:number; customerName:string; proformaIdUsed:number|null; proformaName:string|null; status:string };
type Config = { id:number; orderId:number; color:string; priority:number; enabled:boolean };

export function PriorityScanQueueEditor({ loads }: { loads: Load[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<number,{color:string;priority:string}>>({});
  const { data: configs=[] } = useQuery<Config[]>({ queryKey:["/api/factory/customer-orders/loading-list/priority-scan-configs"] });
  const byOrder = useMemo(() => new Map(configs.map(c => [c.orderId,c])), [configs]);
  const active = useMemo(() => loads.filter(l => l.status === "LOADING").sort((a,b) => (byOrder.get(a.id)?.priority ?? 999999) - (byOrder.get(b.id)?.priority ?? 999999) || a.id-b.id), [loads,byOrder]);
  const refresh = () => qc.invalidateQueries({ queryKey:["/api/factory/customer-orders/loading-list/priority-scan-configs"] });
  const save = useMutation({
    mutationFn: async (v:{orderId:number;color:string;priority:number}) => (await apiRequest("PUT",`/api/factory/customer-orders/${v.orderId}/loading-list/priority-scan-config`,{color:v.color,priority:v.priority,enabled:true})).json(),
    onSuccess: (_d,v) => { setDrafts(p => { const n={...p}; delete n[v.orderId]; return n; }); refresh(); toast({title:"Priority saved"}); },
    onError: (e:Error) => toast({title:"Priority not saved",description:e.message,variant:"destructive"}),
  });
  const clear = useMutation({
    mutationFn: async (id:number) => apiRequest("DELETE",`/api/factory/customer-orders/${id}/loading-list/priority-scan-config`),
    onSuccess: (_d,id) => { setDrafts(p => { const n={...p}; delete n[id]; return n; }); refresh(); toast({title:"Priority cleared"}); },
    onError: (e:Error) => toast({title:"Priority not cleared",description:e.message,variant:"destructive"}),
  });
  if (!active.length) return null;
  return <section className="rounded-lg border bg-card p-4 space-y-3" data-testid="priority-scan-queue-editor">
    <div className="flex items-center gap-2"><Palette className="h-4 w-4"/><div><h3 className="font-semibold">Priority Scan Queue</h3><p className="text-xs text-muted-foreground">Assign one color and unique priority to each pending loading. Priority 1 scans first.</p></div></div>
    <div className="grid gap-2">{active.map(load => {
      const config=byOrder.get(load.id); const draft=drafts[load.id] ?? {color:config?.color ?? "",priority:config?String(config.priority):""}; const priority=Number(draft.priority);
      const canSave=!!load.proformaIdUsed && !!draft.color.trim() && Number.isInteger(priority) && priority>0 && priority<=10000;
      return <div key={load.id} className="grid gap-2 rounded-md border p-3 md:grid-cols-[minmax(180px,1fr)_160px_110px_auto] md:items-center">
        <div className="min-w-0"><div className="font-medium truncate">{load.customerName}</div><div className="text-xs text-muted-foreground">Loading #{load.id}{load.proformaName?` · ${load.proformaName}`:""}</div>{!load.proformaIdUsed && <Badge variant="outline" className="mt-1">Link proforma first</Badge>}</div>
        <Input aria-label={`Color for loading ${load.id}`} placeholder="Color" value={draft.color} maxLength={64} onChange={e=>setDrafts(p=>({...p,[load.id]:{...draft,color:e.target.value}}))}/>
        <Input aria-label={`Priority for loading ${load.id}`} type="number" min={1} max={10000} step={1} placeholder="Priority" value={draft.priority} onChange={e=>setDrafts(p=>({...p,[load.id]:{...draft,priority:e.target.value}}))}/>
        <div className="flex gap-1"><Button size="sm" disabled={!canSave||save.isPending} onClick={()=>save.mutate({orderId:load.id,color:draft.color.trim(),priority})}><Save className="h-4 w-4 mr-1"/>Save</Button>{config&&<Button size="icon" variant="ghost" disabled={clear.isPending} onClick={()=>clear.mutate(load.id)}><X className="h-4 w-4"/></Button>}</div>
      </div>;
    })}</div>
  </section>;
}
