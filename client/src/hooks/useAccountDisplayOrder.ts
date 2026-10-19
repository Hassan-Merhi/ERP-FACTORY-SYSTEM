import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export interface DisplayNode {
  key: string;
  type: "group" | "ledger";
  name: string | null;
  parentKey: string | null;
  order: number;
}
export interface DisplayLayout {
  nodes: DisplayNode[];
}

function sort(a: DisplayNode, b: DisplayNode): number {
  return a.order - b.order || a.key.localeCompare(b.key);
}

export function useAccountDisplayOrder() {
  const { selectedCompany } = useCompany();
  const mode = useAppMode();
  const url = mode === "factory" ? "/api/factory/account-display-layout" : "/api/accounts/display-layout";
  const queryKey = [url, selectedCompany?.id];
  const { toast } = useToast();
  const [arranging, setArranging] = useState(false);
  const { data: layout, isError } = useQuery<DisplayLayout>({
    queryKey,
    queryFn: async () => {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error("Account order unavailable");
      return r.json();
    },
    enabled: !!selectedCompany,
    staleTime: 30000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: me } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const canArrange = !isError && (me?.role === "Admin" || me?.role === "Developer");

  const save = useMutation({
    mutationFn: async (nodes: DisplayNode[]) => {
      const r = await apiRequest("PUT", url, { nodes });
      if (!r.ok) throw new Error("Unable to save account order");
      return r.json() as Promise<DisplayLayout>;
    },
    onMutate: async (nodes) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<DisplayLayout>(queryKey);
      queryClient.setQueryData<DisplayLayout>(queryKey, { nodes });
      return { previous };
    },
    onError: (error: Error, _nodes, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast({ title: "Account order was not saved", description: error.message, variant: "destructive" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const swap = (key: string, targetKey: string) => {
    if (!canArrange || save.isPending || !layout || key === targetKey) return;
    const source = layout.nodes.find((n) => n.key === key);
    const target = layout.nodes.find((n) => n.key === targetKey);
    if (!source || !target || source.parentKey !== target.parentKey || source.type !== target.type) return;
    save.mutate(
      layout.nodes.map((n) =>
        n.key === key ? { ...n, order: target.order } : n.key === targetKey ? { ...n, order: source.order } : n
      )
    );
  };

  // A drag onto a group header assigns that account to the group; dropping
  // onto another account places it immediately above that account.
  const move = (key: string, targetKey: string) => {
    if (!canArrange || save.isPending || !layout || key === targetKey) return;
    const source = layout.nodes.find((n) => n.key === key);
    const target = layout.nodes.find((n) => n.key === targetKey);
    if (!source || !target || (source.type === "group" && target.type !== "group")) return;
    const nextParent = target.type === "group" && source.type === "ledger" ? target.key : target.parentKey;
    if (source.type === "group" && nextParent !== null) return;
    const remaining = layout.nodes.filter((n) => n.key !== key);
    const siblings = remaining.filter((n) => n.parentKey === nextParent).sort(sort);
    const before =
      target.type === "group" && source.type === "ledger" ? -1 : siblings.findIndex((n) => n.key === targetKey);
    siblings.splice(before < 0 ? siblings.length : before, 0, { ...source, parentKey: nextParent });
    const indices = new Map(siblings.map((n, i) => [n.key, i]));
    let next = remaining.map((n) => (indices.has(n.key) ? { ...n, order: indices.get(n.key)! } : n));
    const appended = siblings.find((n) => n.key === key)!;
    next.push({ ...appended, order: indices.get(key)! });
    if (source.parentKey !== nextParent) {
      const oldSiblings = next.filter((n) => n.parentKey === source.parentKey).sort(sort);
      const oldOrder = new Map(oldSiblings.map((n, i) => [n.key, i]));
      next = next.map((n) => (oldOrder.has(n.key) ? { ...n, order: oldOrder.get(n.key)! } : n));
    }
    save.mutate(next);
  };

  return { layout, canArrange, arranging, setArranging, isSaving: save.isPending, swap, move };
}
