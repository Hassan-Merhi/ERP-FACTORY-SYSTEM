import DisplayAccountGroups from "./accounts/DisplayAccountGroups";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErpField, ErpFormActions, ErpPendingButton, ErpConfirmDialog } from "@/erp-core";
import { Layers, Search } from "lucide-react";
import { useLegacyAccountGroupsState } from "./useLegacyAccountGroupsState";
import { LegacyAccountGroupsSection } from "./LegacyAccountGroupsSection";

const ACCOUNT_TYPES = [
  "Asset",
  "Liability",
  "Equity",
  "Income",
  "Expense",
  "Bank",
  "Cash",
  "Indirect Expense",
  "Direct Expense",
  "Government Taxes",
  "Loans",
  "Duty Agent",
  "Transporter Agent",
  "Accounts Payable",
  "Profit",
] as const;

function LegacyAccountGroups() {
  const {
    accountSearch,
    addAccountsOpen,
    assignMutation,
    childCount,
    childrenOfSelected,
    createGroupMutation,
    createOpen,
    dissolveConfirmId,
    dissolveMutation,
    eligibleToAdd,
    filteredGroups,
    groupSearch,
    handleAssignAccounts,
    handleCreateGroup,
    isErp,
    isLoading,
    newGroupName,
    newGroupType,
    removeMutation,
    renameMutation,
    renameName,
    renameOpen,
    selectedGroup,
    selectedGroupId,
    selectedToAdd,
    setAccountSearch,
    setAddAccountsOpen,
    setCreateOpen,
    setDissolveConfirmId,
    setGroupSearch,
    setNewGroupName,
    setNewGroupType,
    setRenameName,
    setRenameOpen,
    setSelectedGroupId,
    setSelectedToAdd,
    toggleSelectToAdd,
  } = useLegacyAccountGroupsState();

  return (
    <div className="min-h-screen bg-background max-md:min-h-full">
      <div className={isErp ? "border-b border-transparent px-6 pt-4 max-md:px-3" : "border-b px-6 py-4 max-md:px-3"}>
        {isErp ? (
          <PageHeader
            title="Account Groups"
            subtitle="Group ledger accounts together for better reporting"
            icon={<Layers className="h-5 w-5 text-primary" />}
          />
        ) : (
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary shrink-0" />
            <PageHeader title="Account Groups" />
            <p className="text-sm text-muted-foreground ml-2 hidden sm:block">
              Group ledger accounts together for better reporting
            </p>
          </div>
        )}
      </div>

      {/* Below md the group list is a bounded pane above the detail pane. */}
      <LegacyAccountGroupsSection
        childCount={childCount}
        childrenOfSelected={childrenOfSelected}
        filteredGroups={filteredGroups}
        groupSearch={groupSearch}
        isLoading={isLoading}
        removeMutation={removeMutation}
        selectedGroup={selectedGroup}
        selectedGroupId={selectedGroupId}
        setAccountSearch={setAccountSearch}
        setAddAccountsOpen={setAddAccountsOpen}
        setCreateOpen={setCreateOpen}
        setDissolveConfirmId={setDissolveConfirmId}
        setGroupSearch={setGroupSearch}
        setRenameName={setRenameName}
        setRenameOpen={setRenameOpen}
        setSelectedGroupId={setSelectedGroupId}
        setSelectedToAdd={setSelectedToAdd}
      />

      {/* Create Group Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Account Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <ErpField id="group-name" label="Group Name" required>
              {(control) => (
                <Input
                  {...control}
                  placeholder="e.g. Fixed Assets, Operating Expenses"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
                  data-testid="input-group-name"
                />
              )}
            </ErpField>
            <ErpField id="group-type" label="Account Type" required>
              {(control) => (
                <Select value={newGroupType} onValueChange={setNewGroupType}>
                  <SelectTrigger {...control} data-testid="select-group-type">
                    <SelectValue placeholder="Select account type…" />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </ErpField>
          </div>
          <ErpFormActions layout="dialog">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <ErpPendingButton
              onClick={handleCreateGroup}
              disabled={!newGroupName.trim() || !newGroupType}
              pending={createGroupMutation.isPending}
              pendingLabel="Creating…"
              data-testid="button-confirm-create-group"
            >
              Create Group
            </ErpPendingButton>
          </ErpFormActions>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Group</DialogTitle>
          </DialogHeader>
          <ErpField id="rename-group" label="Group Name" className="py-2" required>
            {(control) => (
              <Input
                {...control}
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" &&
                  selectedGroup &&
                  renameMutation.mutate({ id: selectedGroup.id, name: renameName.trim() })
                }
                data-testid="input-rename-group"
              />
            )}
          </ErpField>
          <ErpFormActions layout="dialog">
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <ErpPendingButton
              onClick={() => selectedGroup && renameMutation.mutate({ id: selectedGroup.id, name: renameName.trim() })}
              disabled={!renameName.trim()}
              pending={renameMutation.isPending}
              pendingLabel="Saving…"
              data-testid="button-confirm-rename"
            >
              Save
            </ErpPendingButton>
          </ErpFormActions>
        </DialogContent>
      </Dialog>

      {/* Add Accounts Dialog */}
      <Dialog open={addAccountsOpen} onOpenChange={setAddAccountsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Accounts to "{selectedGroup?.name}"</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search accounts…"
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
                className="pl-8"
                data-testid="input-add-account-search"
              />
            </div>
            <div className="max-h-72 overflow-y-auto border rounded-md divide-y">
              {eligibleToAdd.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  {accountSearch ? "No accounts match your search" : "No accounts available to add"}
                </p>
              ) : (
                eligibleToAdd.map((acc) => (
                  <label
                    key={acc.id}
                    className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/50"
                    data-testid={`label-add-account-${acc.id}`}
                  >
                    <Checkbox
                      checked={selectedToAdd.has(acc.id)}
                      onCheckedChange={() => toggleSelectToAdd(acc.id)}
                      data-testid={`checkbox-add-account-${acc.id}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm">{acc.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {acc.code} · {acc.accountType}
                      </div>
                    </div>
                    {acc.parentId && acc.parentId !== selectedGroupId && (
                      <Badge
                        variant="outline"
                        className="text-xs shrink-0 no-default-hover-elevate no-default-active-elevate"
                      >
                        In another group
                      </Badge>
                    )}
                  </label>
                ))
              )}
            </div>
            {selectedToAdd.size > 0 && (
              <p className="text-sm text-muted-foreground">
                {selectedToAdd.size} account{selectedToAdd.size !== 1 ? "s" : ""} selected
              </p>
            )}
          </div>
          <ErpFormActions layout="dialog">
            <Button variant="outline" onClick={() => setAddAccountsOpen(false)}>
              Cancel
            </Button>
            <ErpPendingButton
              onClick={handleAssignAccounts}
              disabled={selectedToAdd.size === 0}
              pending={assignMutation.isPending}
              pendingLabel="Adding…"
              data-testid="button-confirm-add-accounts"
            >
              {`Add ${selectedToAdd.size > 0 ? selectedToAdd.size : ""} Account${selectedToAdd.size !== 1 ? "s" : ""}`}
            </ErpPendingButton>
          </ErpFormActions>
        </DialogContent>
      </Dialog>

      {/* Shared ERP destructive confirmation. Reuses the existing guarded mutation. */}
      <ErpConfirmDialog
        open={dissolveConfirmId !== null}
        onOpenChange={(open) => {
          if (!open) setDissolveConfirmId(null);
        }}
        title="Dissolve this group?"
        description={`This will unlink ${dissolveConfirmId ? childCount(dissolveConfirmId) : 0} account(s) from the group. The accounts and their vouchers remain unchanged.`}
        tone="destructive"
        confirmText="Dissolve Group"
        confirmButtonTestId="button-confirm-dissolve"
        loading={dissolveMutation.isPending}
        onConfirm={async () => {
          if (dissolveConfirmId === null) return;
          await dissolveMutation.mutateAsync(dissolveConfirmId);
        }}
      />
    </div>
  );
}

/** New presentation-only groups are the default; keep old ledger parent trees
 * accessible explicitly for existing installations without migrating their data. */
export default function AccountGroups() {
  const [mode, setMode] = useState<"display" | "ledger">("display");
  return (
    <div>
      <div className="flex flex-wrap gap-2 px-4 pt-4">
        <Button
          variant={mode === "display" ? "default" : "outline"}
          onClick={() => setMode("display")}
          data-testid="button-mode-display-groups"
        >
          Display Groups (no vouchers)
        </Button>
        <Button
          variant={mode === "ledger" ? "default" : "outline"}
          onClick={() => setMode("ledger")}
          data-testid="button-mode-ledger-groups"
        >
          Legacy Ledger Hierarchy
        </Button>
      </div>
      {mode === "display" ? (
        <DisplayAccountGroups />
      ) : (
        <div>
          <p className="mx-4 mt-3 text-sm text-amber-600">
            Legacy ledger parent groups are real accounting accounts. Use Display Groups for new visual groupings.
          </p>
          <LegacyAccountGroups />
        </div>
      )}
    </div>
  );
}
