// Extracted from ./AccountGroups.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErpFormActions, ErpPendingButton } from "@/erp-core";
import { Search } from "lucide-react";
import { useLegacyAccountGroupsState } from "./useLegacyAccountGroupsState";

export function LegacyAccountGroupsDialog({
  accountSearch,
  addAccountsOpen,
  assignMutation,
  eligibleToAdd,
  handleAssignAccounts,
  selectedGroup,
  selectedGroupId,
  selectedToAdd,
  setAccountSearch,
  setAddAccountsOpen,
  toggleSelectToAdd,
}: Pick<
  ReturnType<typeof useLegacyAccountGroupsState>,
  | "accountSearch"
  | "addAccountsOpen"
  | "assignMutation"
  | "eligibleToAdd"
  | "handleAssignAccounts"
  | "selectedGroup"
  | "selectedGroupId"
  | "selectedToAdd"
  | "setAccountSearch"
  | "setAddAccountsOpen"
  | "toggleSelectToAdd"
>) {
  return (
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
  );
}
