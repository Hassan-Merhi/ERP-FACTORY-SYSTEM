import { ArrowDown, ArrowUp, Folder, GripVertical, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErpField, ErpFormActions, ErpPendingButton, ErpConfirmDialog } from "@/erp-core";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/ui/page-state";
import { moveNode, type AccountDisplayNode } from "./DisplayAccountGroupsHelpers";
import { useDisplayAccountGroupsState } from "./useDisplayAccountGroupsState";
export type { AccountDisplayNode, AccountDisplayLayout } from "./DisplayAccountGroupsHelpers";

export default function DisplayAccountGroups() {
  const {
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
  } = useDisplayAccountGroupsState();

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
        draggable={canEditLayout}
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
            {canEditLayout && (
              <Button size="sm" variant="outline" onClick={() => renameGroup(item.key)}>
                Rename
              </Button>
            )}
            {canEditLayout && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${displayName} group`}
                onClick={() => deleteGroup(item.key)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </>
        ) : (
          <Select
            value={item.parentKey || "ungrouped"}
            disabled={!canEditLayout}
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
        {canEditLayout && (
          <>
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
          </>
        )}
      </div>
    );
  };

  return (
    <div data-testid="account-display-groups-root" className="p-4 md:p-6 space-y-4 min-w-0 w-full">
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
        <LoadingState title="Loading layout…" />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {canEditLayout && (
              <>
                <ErpField id="new-display-group" label="New display group" className="min-w-40 flex-1 max-w-sm">
                  {(control) => (
                    <Input
                      {...control}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && createGroup()}
                      placeholder="Group name (e.g. KAZEMBE)"
                      maxLength={120}
                    />
                  )}
                </ErpField>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              data-testid="button-refresh-display-account-layout"
              disabled={dirty || !selectedCompany}
              onClick={() => {
                void refetchLayout();
                void queryClient.invalidateQueries({
                  queryKey: ["/api/ledger-accounts/display-group-picker", selectedCompany?.id],
                });
              }}
            >
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh Layout
            </Button>
            {canEditLayout && (
              <>
                <Button
                  variant="outline"
                  data-testid="button-create-group"
                  onClick={createGroup}
                  disabled={!newName.trim()}
                >
                  <Plus className="h-4 w-4 mr-1" /> New display group
                </Button>
                <ErpPendingButton
                  onClick={() => save.mutate()}
                  disabled={!dirty}
                  pending={save.isPending}
                  pendingLabel="Saving…"
                  className="ml-auto"
                >
                  <Save className="h-4 w-4 mr-1" />
                  Save for all users
                </ErpPendingButton>
              </>
            )}
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
            {nodes.length === 0 && <EmptyState title="No ledger accounts yet." className="rounded-none border-0" />}
          </div>
          {dirty && (
            <p className="text-sm text-amber-600">
              You have unsaved changes. Click Save for all users to publish the order.
            </p>
          )}
        </>
      )}

      <Dialog open={renameKey !== null} onOpenChange={(open) => !open && setRenameKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename display group</DialogTitle>
          </DialogHeader>
          <ErpField id="rename-display-group" label="Group name" required>
            {(control) => (
              <Input
                {...control}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyRename();
                  }
                }}
                maxLength={120}
                data-testid="input-rename-display-group"
              />
            )}
          </ErpField>
          <ErpFormActions layout="dialog">
            <Button type="button" variant="outline" onClick={() => setRenameKey(null)}>
              Cancel
            </Button>
            <ErpPendingButton
              type="button"
              disabled={!renameDraft.trim()}
              onClick={applyRename}
              data-testid="button-confirm-rename-display-group"
            >
              Save name
            </ErpPendingButton>
          </ErpFormActions>
        </DialogContent>
      </Dialog>

      <ErpConfirmDialog
        open={removeKey !== null}
        onOpenChange={(open) => !open && setRemoveKey(null)}
        title="Remove display group?"
        description="Accounts will become ungrouped in the draft layout. Ledger accounts, vouchers and balances will not be deleted. Save for all users to publish the change."
        tone="destructive"
        confirmText="Remove group"
        confirmButtonTestId="button-confirm-remove-display-group"
        onConfirm={applyDelete}
      />
    </div>
  );
}
