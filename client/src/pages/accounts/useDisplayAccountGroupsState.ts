// Extracted from ./DisplayAccountGroups.tsx
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  byOrder,
  moveNode,
  type AccountDisplayNode,
  type AccountDisplayLayout,
  type LedgerOption,
} from "./DisplayAccountGroupsHelpers";

export function useDisplayAccountGroupsState() {
  const { selectedCompany } = useCompany();
  const layoutUrl = useAppMode() === "factory" ? "/api/factory/account-display-layout" : "/api/accounts/display-layout";
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const canEditLayout = recordChanges.allowed;
  const [nodes, setNodes] = useState<AccountDisplayNode[]>([]);
  const [newName, setNewName] = useState("");
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [removeKey, setRemoveKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const layoutKey = [layoutUrl, selectedCompany?.id];
  const {
    data: layout,
    isLoading: loadingLayout,
    error: layoutError,
    refetch: refetchLayout,
  } = useQuery<AccountDisplayLayout>({
    queryKey: layoutKey,
    queryFn: async () => {
      const r = await fetch(layoutUrl, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Cannot load account groups");
      const body = (await r.json()) as Partial<AccountDisplayLayout> | null;
      // A successful response without a nodes list is not a layout. Treating
      // it as an empty editable layout would let Save replace the company-wide
      // order with the synthesized rows, so it surfaces as a load error instead.
      if (!body || !Array.isArray(body.nodes)) throw new Error("Account groups layout could not be read");
      return body as AccountDisplayLayout;
    },
    enabled: !!selectedCompany,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const { data: accounts = [], isLoading: loadingAccounts } = useQuery<LedgerOption[]>({
    queryKey: ["/api/ledger-accounts/display-group-picker", selectedCompany?.id],
    queryFn: async () => {
      const r = await fetch(`/api/ledger-accounts?companyId=${selectedCompany!.id}`, { credentials: "include" });
      if (!r.ok) throw new Error("Cannot load ledger accounts");
      return r.json();
    },
    enabled: !!selectedCompany,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const ledgerOptions = useMemo(
    () => (Array.isArray(accounts) ? accounts : []).filter((a) => a.subType !== "Group"),
    [accounts]
  );
  const accountMap = useMemo(() => new Map(ledgerOptions.map((a) => [`ledger:${a.id}`, a])), [ledgerOptions]);

  useEffect(() => {
    if (!layout || loadingAccounts) return;
    const retained = (Array.isArray(layout.nodes) ? layout.nodes : []).filter(
      (n) => n.type === "group" || accountMap.has(n.key)
    );
    const known = new Set(retained.map((n) => n.key));
    const additional = ledgerOptions
      .filter((a) => !known.has(`ledger:${a.id}`))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a, i) => ({
        key: `ledger:${a.id}`,
        type: "ledger" as const,
        name: null,
        parentKey: null,
        order: 10000 + i,
      }));
    setNodes([...retained, ...additional]);
    setDirty(false);
  }, [layout, loadingAccounts, accountMap, ledgerOptions, selectedCompany?.id]);

  const groups = useMemo(() => nodes.filter((n) => n.type === "group").sort(byOrder), [nodes]);
  const orderedRoot = useMemo(() => nodes.filter((n) => !n.parentKey).sort(byOrder), [nodes]);
  const groupItems = (key: string) => nodes.filter((n) => n.parentKey === key).sort(byOrder);

  const mutate = (next: AccountDisplayNode[]) => {
    if (!canEditLayout) return;
    setNodes(next);
    setDirty(true);
  };
  const save = useMutation({
    mutationFn: () => {
      if (!canEditLayout) throw new Error(recordChanges.reason ?? "");
      return apiRequest("PUT", layoutUrl, { nodes });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [layoutUrl] });
      toast({ title: "Account order saved for all users" });
    },
    onError: (error: Error) =>
      toast({ title: "Unable to save order", description: error.message, variant: "destructive" }),
  });

  const createGroup = () => {
    const name = newName.trim();
    if (!name || name.length > 120) return;
    const key = `group:${crypto.randomUUID()}`;
    mutate([...nodes, { key, type: "group", name, parentKey: null, order: orderedRoot.length }]);
    setNewName("");
  };
  // Display grouping is presentation-only; changes are staged until Save.
  const renameGroup = (key: string) => {
    const current = nodes.find((node) => node.key === key);
    if (!current || current.type !== "group") return;
    setRenameKey(key);
    setRenameDraft(current.name ?? "");
  };
  const applyRename = () => {
    const name = renameDraft.trim();
    if (!renameKey || !name || name.length > 120) return;
    mutate(nodes.map((node) => (node.key === renameKey ? { ...node, name } : node)));
    setRenameKey(null);
    setRenameDraft("");
  };
  const deleteGroup = (key: string) => {
    if (nodes.some((node) => node.key === key && node.type === "group")) setRemoveKey(key);
  };
  const applyDelete = () => {
    if (!removeKey) return;
    let next = nodes
      .filter((node) => node.key !== removeKey)
      .map((node) => (node.parentKey === removeKey ? { ...node, parentKey: null } : node));
    next = next.map((node, index) => ({ ...node, order: node.parentKey ? node.order : index }));
    mutate(next);
    setRemoveKey(null);
  };
  const reorderOne = (key: string, direction: -1 | 1) => {
    const item = nodes.find((n) => n.key === key);
    if (!item) return;
    const siblings = nodes.filter((n) => n.parentKey === item.parentKey).sort(byOrder);
    const index = siblings.findIndex((n) => n.key === key);
    const target = index + direction;
    if (target < 0 || target >= siblings.length) return;
    const reordered = [...siblings];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    const pos = new Map(reordered.map((n, i) => [n.key, i]));
    mutate(nodes.map((n) => (pos.has(n.key) ? { ...n, order: pos.get(n.key)! } : n)));
  };
  const drop = (targetKey: string, parentKey: string | null) => {
    if (!draggedKey || draggedKey === targetKey) return;
    const dragged = nodes.find((n) => n.key === draggedKey);
    const target = nodes.find((n) => n.key === targetKey);
    if (!dragged || !target) return;
    // Dropping a ledger on a group header assigns it to that group.
    const destination = target.type === "group" && dragged.type === "ledger" ? target.key : parentKey;
    mutate(
      moveNode(
        nodes,
        draggedKey,
        destination,
        target.type === "ledger" || dragged.type === "group" ? targetKey : undefined
      )
    );
    setDraggedKey(null);
  };
  const groupName = (item: AccountDisplayNode) => item.name || "";
  return {
    selectedCompany,
    canEditLayout,
    nodes,
    newName,
    setNewName,
    renameKey,
    setRenameKey,
    renameDraft,
    setRenameDraft,
    removeKey,
    setRemoveKey,
    search,
    setSearch,
    setDraggedKey,
    dirty,
    layoutError,
    loadingLayout,
    refetchLayout,
    loadingAccounts,
    accountMap,
    groups,
    orderedRoot,
    groupItems,
    mutate,
    save,
    createGroup,
    renameGroup,
    applyRename,
    deleteGroup,
    applyDelete,
    reorderOne,
    drop,
    groupName,
  };
}
