// Extracted from ./AccountGroups.tsx to keep that module under the source-size cap.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Folder, FolderOpen, Pencil, Plus, Trash2, UserPlus, X } from "lucide-react";
import { useLegacyAccountGroupsState } from "./useLegacyAccountGroupsState";

export function LegacyAccountGroupsSection({
  childCount,
  childrenOfSelected,
  filteredGroups,
  groupSearch,
  isLoading,
  removeMutation,
  selectedGroup,
  selectedGroupId,
  setAccountSearch,
  setAddAccountsOpen,
  setCreateOpen,
  setDissolveConfirmId,
  setGroupSearch,
  setRenameName,
  setRenameOpen,
  setSelectedGroupId,
  setSelectedToAdd,
}: Pick<
  ReturnType<typeof useLegacyAccountGroupsState>,
  | "childCount"
  | "childrenOfSelected"
  | "filteredGroups"
  | "groupSearch"
  | "isLoading"
  | "removeMutation"
  | "selectedGroup"
  | "selectedGroupId"
  | "setAccountSearch"
  | "setAddAccountsOpen"
  | "setCreateOpen"
  | "setDissolveConfirmId"
  | "setGroupSearch"
  | "setRenameName"
  | "setRenameOpen"
  | "setSelectedGroupId"
  | "setSelectedToAdd"
>) {
  return (
    <div className="flex h-[calc(100dvh-73px)] max-md:h-auto max-md:min-h-0 max-md:flex-col">
      {/* Left panel */}
      <div className="w-72 border-r flex flex-col shrink-0 max-md:w-full max-md:max-h-[min(44dvh,24rem)] max-md:flex-none max-md:border-r-0 max-md:border-b">
        <div className="p-4 border-b space-y-3">
          <Button className="w-full" onClick={() => setCreateOpen(true)} data-testid="button-create-group">
            <Plus className="h-4 w-4 mr-2" />
            New Group
          </Button>
          <SearchField
            placeholder="Search groups…"
            value={groupSearch}
            onValueChange={setGroupSearch}
            data-testid="input-group-search"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)
          ) : filteredGroups.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {groupSearch ? "No groups match your search" : "No groups yet — click New Group to start"}
            </div>
          ) : (
            filteredGroups.map((group) => (
              <button
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
                className={`w-full text-left rounded-md p-3 transition-colors hover-elevate ${
                  selectedGroupId === group.id ? "bg-primary/10 text-primary" : ""
                }`}
                data-testid={`button-group-${group.id}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {selectedGroupId === group.id ? (
                    <FolderOpen className="h-4 w-4 shrink-0" />
                  ) : (
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">{group.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{group.accountType}</div>
                  </div>
                  <Badge
                    variant="secondary"
                    className="shrink-0 text-xs no-default-hover-elevate no-default-active-elevate"
                  >
                    {childCount(group.id)}
                  </Badge>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 overflow-y-auto p-6 max-md:w-full max-md:min-w-0 max-md:overflow-visible max-md:p-3">
        {!selectedGroup ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
            <Folder className="h-12 w-12 opacity-30" />
            <div className="text-center">
              <p className="font-medium">Select a group</p>
              <p className="text-sm mt-1">Choose a group from the left to manage its accounts</p>
            </div>
          </div>
        ) : (
          <div className="max-w-2xl space-y-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{selectedGroup.name}</h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setRenameName(selectedGroup.name);
                      setRenameOpen(true);
                    }}
                    data-testid="button-rename-group"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  {selectedGroup.accountType} · Code: {selectedGroup.code}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="outline"
                  onClick={() => setDissolveConfirmId(selectedGroup.id)}
                  data-testid="button-dissolve-group"
                >
                  <X className="h-4 w-4 mr-2" />
                  Dissolve Group
                </Button>
                <Button
                  onClick={() => {
                    setSelectedToAdd(new Set());
                    setAccountSearch("");
                    setAddAccountsOpen(true);
                  }}
                  data-testid="button-add-accounts"
                >
                  <UserPlus className="h-4 w-4 mr-2" />
                  Add Accounts
                </Button>
              </div>
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Member Accounts ({childrenOfSelected.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {childrenOfSelected.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    No accounts assigned yet. Click "Add Accounts" to add some.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {childrenOfSelected.map((child) => (
                      <div
                        key={child.id}
                        className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/50 group"
                        data-testid={`row-child-${child.id}`}
                      >
                        <div className="min-w-0">
                          <span className="font-medium text-sm">{child.name}</span>
                          <span className="text-xs text-muted-foreground ml-2">{child.code}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="text-xs shrink-0 no-default-hover-elevate no-default-active-elevate"
                          >
                            {child.accountType}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="opacity-0 group-hover:opacity-100 touch:opacity-100 shrink-0"
                            onClick={() => removeMutation.mutate(child.id)}
                            disabled={removeMutation.isPending}
                            data-testid={`button-remove-child-${child.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
