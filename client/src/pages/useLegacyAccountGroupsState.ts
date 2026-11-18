// Extracted from ./AccountGroups.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { accountsApi } from "@/api/accountsApi";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import type { LedgerAccount } from "@shared/schema";

export function useLegacyAccountGroupsState() {
  const isErp = useAppMode() === "erp";
  const { toast } = useToast();
  const { selectedCompany } = useCompany();

  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addAccountsOpen, setAddAccountsOpen] = useState(false);
  const [dissolveConfirmId, setDissolveConfirmId] = useState<number | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [accountSearch, setAccountSearch] = useState("");
  const [selectedToAdd, setSelectedToAdd] = useState<Set<number>>(new Set());

  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupType, setNewGroupType] = useState<string>("");
  const [renameName, setRenameName] = useState("");

  const { data: allAccounts = [], isLoading } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", selectedCompany?.id],
    queryFn: async () => {
      const url = selectedCompany?.id ? `/api/ledger-accounts?companyId=${selectedCompany.id}` : "/api/ledger-accounts";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch accounts");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  // Groups = accounts marked with subType "Group" OR accounts that happen to have children
  // (backward-compat: groups created before subType tagging still show up)
  const childAccountIds = useMemo(() => {
    const set = new Set<number>();
    allAccounts.forEach((a) => {
      if (a.parentId) set.add(a.parentId);
    });
    return set;
  }, [allAccounts]);

  const parentGroups = useMemo(
    () => allAccounts.filter((a) => a.subType === "Group" || childAccountIds.has(a.id)),
    [allAccounts, childAccountIds]
  );

  const filteredGroups = useMemo(
    () =>
      parentGroups.filter(
        (g) =>
          g.name.toLowerCase().includes(groupSearch.toLowerCase()) ||
          g.code.toLowerCase().includes(groupSearch.toLowerCase())
      ),
    [parentGroups, groupSearch]
  );

  const selectedGroup = useMemo(
    () => allAccounts.find((a) => a.id === selectedGroupId) ?? null,
    [allAccounts, selectedGroupId]
  );

  const childrenOfSelected = useMemo(
    () => allAccounts.filter((a) => a.parentId === selectedGroupId),
    [allAccounts, selectedGroupId]
  );

  // Eligible accounts to add: exclude the group itself, already-children, other groups
  const groupIds = useMemo(() => new Set(parentGroups.map((g) => g.id)), [parentGroups]);

  const eligibleToAdd = useMemo(() => {
    if (!selectedGroupId) return [];
    const childIds = new Set(childrenOfSelected.map((c) => c.id));
    return allAccounts.filter(
      (a) =>
        a.id !== selectedGroupId &&
        !childIds.has(a.id) &&
        !groupIds.has(a.id) &&
        a.name.toLowerCase().includes(accountSearch.toLowerCase())
    );
  }, [allAccounts, selectedGroupId, childrenOfSelected, accountSearch, groupIds]);

  // --- Mutations ---
  const createGroupMutation = useMutation({
    mutationFn: async ({ name, accountType }: { name: string; accountType: string }) => {
      if (!selectedCompany?.id) throw new Error("No company selected");
      const res = await accountsApi.createLedgerAccount({
        name,
        accountType,
        subType: "Group",
        companyId: selectedCompany.id,
      });
      return (await res.json()) as LedgerAccount;
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      setCreateOpen(false);
      setNewGroupName("");
      setNewGroupType("");
      setSelectedGroupId(data.id);
      toast({ title: "Group created", description: `"${data.name}" is ready — add accounts to it.` });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Failed to create group", description: err.message, variant: "destructive" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      if (!selectedGroup) throw new Error("No group selected");
      return accountsApi.updateLedgerAccount(id, {
        id,
        name,
        accountType: selectedGroup.accountType,
        subType: "Group",
        companyId: selectedCompany?.id,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      setRenameOpen(false);
      toast({ title: "Group renamed" });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Failed to rename", description: err.message, variant: "destructive" });
    },
  });

  const assignMutation = useMutation({
    mutationFn: async ({ accountIds, parentId }: { accountIds: number[]; parentId: number | null }) =>
      accountsApi.bulkAssignParent(accountIds, parentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      setAddAccountsOpen(false);
      setSelectedToAdd(new Set());
      setAccountSearch("");
      toast({ title: "Accounts added to group" });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Failed to assign accounts", description: err.message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (accountId: number) => accountsApi.bulkAssignParent([accountId], null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      toast({ title: "Account removed from group" });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Failed to remove account", description: err.message, variant: "destructive" });
    },
  });

  // Dissolve = unlink all children + remove Group subType so it disappears from the groups list
  const dissolveMutation = useMutation({
    mutationFn: async (groupId: number) => {
      const children = allAccounts.filter((a) => a.parentId === groupId);
      if (children.length > 0) {
        await accountsApi.bulkAssignParent(
          children.map((c) => c.id),
          null
        );
      }
      const group = allAccounts.find((a) => a.id === groupId);
      if (!group) return;
      await accountsApi.updateLedgerAccount(groupId, {
        id: groupId,
        name: group.name,
        accountType: group.accountType,
        subType: null,
        companyId: selectedCompany?.id,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      setDissolveConfirmId(null);
      setSelectedGroupId(null);
      toast({ title: "Group dissolved", description: "All accounts have been unlinked." });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Failed to dissolve group", description: err.message, variant: "destructive" });
    },
  });

  const handleCreateGroup = () => {
    if (!newGroupName.trim() || !newGroupType) return;
    createGroupMutation.mutate({ name: newGroupName.trim(), accountType: newGroupType });
  };

  const handleAssignAccounts = () => {
    if (!selectedGroupId || selectedToAdd.size === 0) return;
    assignMutation.mutate({ accountIds: Array.from(selectedToAdd), parentId: selectedGroupId });
  };

  const toggleSelectToAdd = (id: number) => {
    setSelectedToAdd((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const childCount = (groupId: number) => allAccounts.filter((a) => a.parentId === groupId).length;
  return {
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
  };
}
