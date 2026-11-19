// Extracted from ./UserManagementDrawer.tsx
import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { usePasswordConfirmedAction } from "@/hooks/use-password-confirmed-action";
import type { SettingsUserRow } from "../settingsTypes";
import type { Company } from "@shared/schema";

export interface UserManagementDrawerProps {
  user: SettingsUserRow;
  open: boolean;
  onClose: () => void;
  companies: Company[];
  onUserDeleted: () => void;
}

export function useUserManagementDrawerState({
  user,
  onUserDeleted,
}: Pick<UserManagementDrawerProps, "user" | "onUserDeleted">) {
  const { toast } = useToast();
  const { requestPasswordConfirmation, PasswordConfirmationDialog } = usePasswordConfirmedAction();
  const isPrivileged = ["admin", "owner", "developer"].includes(user?.role?.toLowerCase() ?? "");
  const isViewOnly = user?.role?.toLowerCase() === "view only";

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [hasErpAccess, setHasErpAccess] = useState(true);
  const [hasFactoryAccess, setHasFactoryAccess] = useState(true);
  const [pageAccess, setPageAccess] = useState<Set<string>>(new Set());
  const [hiddenCostFields, setHiddenCostFields] = useState<string[]>([]);
  const [hiddenErpCostFields, setHiddenErpCostFields] = useState<string[]>([]);

  const [newPassword, setNewPassword] = useState("");
  const [, setShowPasswordReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [, setAdvancedOpen] = useState(false);
  const [openTabGroups, setOpenTabGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (user) {
      setUsername(user.username ?? "");
      setDisplayName(user.displayName ?? "");
      setHasErpAccess(isPrivileged ? true : (user.hasErpAccess ?? true));
      setHasFactoryAccess(isPrivileged ? true : (user.hasFactoryAccess ?? true));
      setPageAccess(new Set(user.pageAccess ?? []));
      setHiddenCostFields(user.hiddenCostFields ?? []);
      setNewPassword("");
      setShowPasswordReset(false);
      setAdvancedOpen(false);
    }
  }, [isPrivileged, user, user?.id]);

  const { data: erpHiddenCostData } = useQuery<{ hiddenCostFields: string[] }>({
    queryKey: ["/api/erp-user-hidden-costs", user?.id],
    queryFn: async () => {
      const res = await fetch(`/api/erp-user-hidden-costs/${user?.id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch ERP hidden cost fields");
      return res.json();
    },
    enabled: !!user?.id,
  });

  useEffect(() => {
    if (erpHiddenCostData?.hiddenCostFields) {
      setHiddenErpCostFields(erpHiddenCostData.hiddenCostFields);
    }
  }, [erpHiddenCostData]);

  const updateMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await factoryApiRequest("PUT", `/api/factory/users/${user.id}`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update user");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/users"] });
      toast({ title: "Saved", description: "User updated successfully" });
      setNewPassword("");
      setShowPasswordReset(false);
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("DELETE", `/api/factory/users/${user.id}`, {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to remove user");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/users"] });
      toast({ title: "Removed", description: `${user.username} has been removed` });
      setConfirmDelete(false);
      onUserDeleted();
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const saveErpRestrictionsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/erp-user-hidden-costs/${user.id}`, {
        hiddenCostFields: isPrivileged ? [] : hiddenErpCostFields,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to save ERP restrictions");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/erp-user-hidden-costs", user.id] });
      toast({ title: "Saved", description: "ERP cost field restrictions updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleTabGroup = (group: string) => {
    setOpenTabGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const isDirty = useMemo(() => {
    if (!user) return false;
    const origPageAccess = new Set(user.pageAccess ?? []);
    const pageSetChanged =
      pageAccess.size !== origPageAccess.size || Array.from(pageAccess).some((k) => !origPageAccess.has(k));
    const sortedCost = JSON.stringify([...hiddenCostFields].sort());
    const origSortedCost = JSON.stringify([...(user.hiddenCostFields ?? [])].sort());
    const sortedErp = JSON.stringify([...hiddenErpCostFields].sort());
    const origSortedErp = JSON.stringify([...(erpHiddenCostData?.hiddenCostFields ?? [])].sort());
    return (
      username !== (user.username ?? "") ||
      displayName !== (user.displayName ?? "") ||
      !!newPassword ||
      (!isPrivileged && hasErpAccess !== (user.hasErpAccess ?? true)) ||
      (!isPrivileged && hasFactoryAccess !== (user.hasFactoryAccess ?? true)) ||
      (!isPrivileged && pageSetChanged) ||
      (!isPrivileged && sortedCost !== origSortedCost) ||
      (!isPrivileged && sortedErp !== origSortedErp)
    );
  }, [
    user,
    username,
    displayName,
    newPassword,
    hasErpAccess,
    hasFactoryAccess,
    pageAccess,
    hiddenCostFields,
    hiddenErpCostFields,
    erpHiddenCostData,
    isPrivileged,
  ]);

  const handleSaveAll = () => {
    const payload: {
      displayName: string;
      username?: string;
      password?: string;
      hasErpAccess?: boolean;
      hasFactoryAccess?: boolean;
      pageAccess?: string[];
      hiddenCostFields?: string[];
    } = {
      displayName,
    };
    if (username !== user.username) payload.username = username;
    if (newPassword) payload.password = newPassword;
    if (!isPrivileged) {
      payload.hasErpAccess = hasErpAccess;
      payload.hasFactoryAccess = hasFactoryAccess;
      payload.pageAccess = Array.from(pageAccess);
      payload.hiddenCostFields = hiddenCostFields;
    }
    requestPasswordConfirmation(
      () =>
        updateMutation.mutate(payload, {
          onSuccess: () => {
            if (!isPrivileged) saveErpRestrictionsMutation.mutate();
          },
        }),
      "Update User"
    );
  };

  const handleDiscard = () => {
    if (!user) return;
    setUsername(user.username ?? "");
    setDisplayName(user.displayName ?? "");
    setHasErpAccess(isPrivileged ? true : (user.hasErpAccess ?? true));
    setHasFactoryAccess(isPrivileged ? true : (user.hasFactoryAccess ?? true));
    setPageAccess(new Set(user.pageAccess ?? []));
    setHiddenCostFields(user.hiddenCostFields ?? []);
    setHiddenErpCostFields(erpHiddenCostData?.hiddenCostFields ?? []);
    setNewPassword("");
    setShowPasswordReset(false);
  };
  return {
    requestPasswordConfirmation,
    PasswordConfirmationDialog,
    isPrivileged,
    isViewOnly,
    username,
    setUsername,
    displayName,
    setDisplayName,
    hasErpAccess,
    setHasErpAccess,
    hasFactoryAccess,
    setHasFactoryAccess,
    pageAccess,
    setPageAccess,
    hiddenCostFields,
    setHiddenCostFields,
    hiddenErpCostFields,
    setHiddenErpCostFields,
    newPassword,
    setNewPassword,
    setConfirmDelete,
    confirmDelete,
    openTabGroups,
    updateMutation,
    deleteMutation,
    saveErpRestrictionsMutation,
    toggleTabGroup,
    isDirty,
    handleSaveAll,
    handleDiscard,
  };
}
