import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Folder, GripVertical, Plus, Save, Trash2 } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type AccountDisplayNode = {
  key: string;
  type: "group" | "ledger";
  name: string | null;
  parentKey: string | null;
  order: number;
};
export type AccountDisplayLayout = { nodes: AccountDisplayNode[] };

type LedgerOption = { id: number; name: string; code: string; subType: string | null };

const byOrder = (a: AccountDisplayNode, b: AccountDisplayNode) => a.order - b.order || a.key.localeCompare(b.key);

/** Move a single layout entry without changing any ledger account or voucher. */
function moveNode(nodes: AccountDisplayNode[], key: string, parentKey: string | null, beforeKey?: string) {
  const moving = nodes.find((n) => n.key === key);
  if (!moving || (moving.type === "group" && parentKey !== null) || parentKey === key) return nodes;
  if (parentKey && !nodes.some((n) => n.type === "group" && n.key === parentKey)) return nodes;
  const result = nodes.map((n) => (n.key === key ? { ...n, parentKey } : { ...n }));
  const siblings = result.filter((n) => n.key !== key && n.parentKey === parentKey).sort(byOrder);
  const index = beforeKey ? siblings.findIndex((n) => n.key === beforeKey) : -1;
  siblings.splice(
    index < 0 ? siblings.length : index,
    0,
    result.find((n) => n.key === key)!
  );
  const positions = new Map(siblings.map((n, i) => [n.key, i]));
  return result.map((n) => (positions.has(n.key) ? { ...n, order: positions.get(n.key)! } : n));
}

export default function DisplayAccountGroups() {
  const { selectedCompany } = useCompany();
  const layoutUrl = useAppMode() === "factory" ? "/api/factory/account-display-layout" : "/api/accounts/display-layout";
  const { toast } = useToast();
  const [nodes, setNodes] = useState<AccountDisplayNode[]>([]);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const layoutKey = [layoutUrl, selectedCompany?.id];
  const {
    data: layout,
    isLoading: loadingLayout,
    error: layoutError,
  } = useQuery<AccountDisplayLayout>({
    queryKey: layoutKey,
    queryFn: async () => {
      const r = await fetch(layoutUrl, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Cannot load account groups");
      return r.json();
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

  const ledgerOptions = useMemo(() => accounts.filter((a) => a.subType !== "Group"), [accounts]);
  const accountMap = useMemo(() => new Map(ledgerOptions.map((a) => [`ledger:${a.id}`, a])), [ledgerOptions]);

  useEffect(() => {
    if (!layout || loadingAccounts) return;
    const retained = layout.nodes.filter((n) => n.type === "group" || accountMap.has(n.key));
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
    setNodes(next);
    setDirty(true);
  };
  const save = useMutation({
    mutationFn: () => apiRequest("PUT", layoutUrl, { nodes }),
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
  const renameGroup = (key: string) => {
    const current = nodes.find((n) => n.key === key);
    const next = window.prompt("Rename display group", current?.name ?? "");
    if (next == null || !next.trim() || next.trim().length > 120) return;
    mutate(nodes.map((n) => (n.key === key ? { ...n, name: next.trim() } : n)));
  };
  const deleteGroup = (key: string) => {
    if (!window.confirm("Remove this display group? Its accounts and vouchers remain unchanged.")) return;
    let next = nodes.filter((n) => n.key !== key).map((n) => (n.parentKey === key ? { ...n, parentKey: null } : n));
    next = next.map((n, i) => ({ ...n, order: n.parentKey ? n.order : i }));
    mutate(next);
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

  const renderRow = (item: AccountDisplayNode, depth = 0) => {
    const account = item.type === "ledger" ? accountMap.get(item.key) : undefined;
    const isGroup = item.type === "group";
    const displayName = isGroup ? groupName(item) : account?.name || item.key;
    if (
      !isGroup &&
      search &&
      !displayName.toLowerCase().includes(search.toLowerCase()) &&
      !account?.code?.toLowerCase().includes(search.toLowerCase())
    )
      return null;
    return (
      <div
        key={item.key}
        draggable
        onDragStart={(e) => {
          setDraggedKey(item.key);
          e.dataTransfer.setData("text/plain", item.key);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDraggedKey(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          drop(item.key, item.parentKey);
        }}
        className={`flex flex-wrap items-center gap-2 border-b last:border-b-0 px-3 py-2 ${isGroup ? "bg-muted/40 font-semibold" : ""} ${depth ? "pl-9" : ""}`}
        data-testid={`display-layout-${item.key}`}
      >
        <GripVertical className="h-4 w-4 text-muted-foreground shrink-0 cursor-grab" aria-hidden="true" />
        {isGroup && <Folder className="h-4 w-4 text-primary shrink-0" />}
        <span className="text-sm min-w-0 flex-1">{displayName}</span>
        {account && <span className="text-xs text-muted-foreground">#{account.id}</span>}
        {isGroup ? (
          <>
            <span className="text-xs text-muted-foreground">{groupItems(item.key).length} accounts</span>
            <Button size="sm" variant="outline" onClick={() => renameGroup(item.key)}>
              Rename
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove ${displayName} group`}
              onClick={() => deleteGroup(item.key)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <Select
            value={item.parentKey || "ungrouped"}
            onValueChange={(v) => mutate(moveNode(nodes, item.key, v === "ungrouped" ? null : v))}
          >
            <SelectTrigger className="w-40 h-8 text-xs" aria-label={`Group for ${displayName}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ungrouped">Ungrouped</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.key} value={g.key}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Move ${displayName} up`}
          onClick={() => reorderOne(item.key, -1)}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Move ${displayName} down`}
          onClick={() => reorderOne(item.key, 1)}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      </div>
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Display-only Account Groups</h2>
        <p className="text-sm text-muted-foreground">
          Drag groups/accounts into order or use the arrows. Use the dropdown to move an account under a group. These
          are headings only: no ledger accounts, vouchers, or balances are created or changed.
        </p>
      </div>
      {layoutError ? (
        <p role="alert" className="text-sm text-destructive">
          {(layoutError as Error).message}
        </p>
      ) : loadingLayout || loadingAccounts ? (
        <p className="text-sm text-muted-foreground">Loading layout…</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createGroup()}
              placeholder="Group name (e.g. KAZEMBE)"
              className="max-w-sm"
            />
            <Button variant="outline" onClick={createGroup} disabled={!newName.trim()}>
              <Plus className="h-4 w-4 mr-1" /> New display group
            </Button>
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending} className="ml-auto">
              <Save className="h-4 w-4 mr-1" /> {save.isPending ? "Saving…" : "Save for all users"}
            </Button>
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find an account in this layout…"
            className="max-w-lg"
          />
          <div className="rounded-lg border overflow-hidden">
            {orderedRoot.map((item) => (
              <div key={item.key}>
                {renderRow(item)}
                {item.type === "group" && groupItems(item.key).map((child) => renderRow(child, 1))}
              </div>
            ))}
            {nodes.length === 0 && <div className="p-6 text-sm text-muted-foreground">No ledger accounts yet.</div>}
          </div>
          {dirty && (
            <p className="text-sm text-amber-600">
              You have unsaved changes. Click Save for all users to publish the order.
            </p>
          )}
        </>
      )}
    </div>
  );
}
