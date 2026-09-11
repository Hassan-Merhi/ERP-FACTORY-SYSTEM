import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { usePasswordConfirmedAction } from "@/hooks/use-password-confirmed-action";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Shield, Save } from "lucide-react";
import { UserManagementForm } from "./UserManagementForm";

interface UserManagementDrawerProps {
  user: any | null;
  open: boolean;
  onClose: () => void;
  companies: unknown[];
  onUserDeleted: () => void;
}

export function UserManagementDrawer({ user, open, onClose, companies, onUserDeleted }: UserManagementDrawerProps) {
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
  const [_showPasswordReset, setShowPasswordReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [_advancedOpen, setAdvancedOpen] = useState(false);
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const _handleSaveAccount = () => {
    updateMutation.mutate({
      username: username !== user.username ? username : undefined,
      displayName,
      password: newPassword || undefined,
    });
  };

  const _handleSaveAccess = () => {
    updateMutation.mutate({
      hasErpAccess: isPrivileged ? true : hasErpAccess,
      hasFactoryAccess: isPrivileged ? true : hasFactoryAccess,
    });
  };

  const _handleSaveRestrictions = () => {
    updateMutation.mutate({
      pageAccess: Array.from(pageAccess),
      hiddenCostFields: isPrivileged ? [] : hiddenCostFields,
    });
  };

  const _togglePage = (key: string) => {
    setPageAccess((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const _toggleGroup = (group: string, pages: { key: string }[]) => {
    const allSelected = pages.every((p) => pageAccess.has(p.key));
    setPageAccess((prev) => {
      const next = new Set(prev);
      pages.forEach((p) => (allSelected ? next.delete(p.key) : next.add(p.key)));
      return next;
    });
  };

  const _toggleCostField = (key: string) => {
    setHiddenCostFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const _toggleErpCostField = (key: string) => {
    setHiddenErpCostFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

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
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const _handleSaveErpRestrictions = () => saveErpRestrictionsMutation.mutate();

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

  if (!user) return null;

  const accessLabel =
    (isPrivileged || hasErpAccess) && (isPrivileged || hasFactoryAccess)
      ? "ERP + Factory"
      : isPrivileged || hasErpAccess
        ? "ERP only"
        : isPrivileged || hasFactoryAccess
          ? "Factory only"
          : "No access";

  const _restrictionCount =
    (isPrivileged ? 0 : pageAccess.size) +
    (isPrivileged ? 0 : hiddenCostFields.length) +
    (isPrivileged ? 0 : hiddenErpCostFields.length);

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-[520px] p-0 flex flex-col">
          <SheetHeader className="px-6 py-4 border-b shrink-0">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted font-bold text-base uppercase text-muted-foreground">
                {(user.displayName || user.username).charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <SheetTitle className="text-lg leading-tight">{user.displayName || user.username}</SheetTitle>
                {user.displayName && (
                  <SheetDescription className="font-mono text-xs mt-0">{user.username}</SheetDescription>
                )}
              </div>
              {isPrivileged && (
                <Badge variant="default" className="capitalize gap-1 shrink-0">
                  <Shield className="h-3 w-3" />
                  {user.role}
                </Badge>
              )}
              {isViewOnly && (
                <Badge
                  variant="outline"
                  className="gap-1 shrink-0 border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300"
                >
                  View Only
                </Badge>
              )}
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            <UserManagementForm
              user={user}
              username={username}
              setUsername={setUsername}
              displayName={displayName}
              setDisplayName={setDisplayName}
              newPassword={newPassword}
              setNewPassword={setNewPassword}
              hasErpAccess={hasErpAccess}
              setHasErpAccess={setHasErpAccess}
              hasFactoryAccess={hasFactoryAccess}
              setHasFactoryAccess={setHasFactoryAccess}
              isPrivileged={isPrivileged}
              isViewOnly={isViewOnly}
              accessLabel={accessLabel}
              companies={companies}
              setConfirmDelete={setConfirmDelete}
              pageAccess={pageAccess}
              hiddenCostFields={hiddenCostFields}
              hiddenErpCostFields={hiddenErpCostFields}
              setPageAccess={setPageAccess}
              setHiddenCostFields={setHiddenCostFields}
              setHiddenErpCostFields={setHiddenErpCostFields}
              openTabGroups={openTabGroups}
              toggleTabGroup={toggleTabGroup}
            />
          </div>

          {isDirty && (
            <div className="shrink-0 border-t px-6 py-3 bg-background flex items-center justify-between gap-3 flex-wrap z-50">
              <p className="text-xs text-muted-foreground">
                {newPassword ? "Unsaved changes · includes new password" : "Unsaved changes"}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDiscard}
                  disabled={updateMutation.isPending || saveErpRestrictionsMutation.isPending}
                  data-testid="button-discard-changes"
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="gap-2"
                  onClick={handleSaveAll}
                  disabled={updateMutation.isPending || saveErpRestrictionsMutation.isPending}
                  data-testid="button-save-all-changes"
                >
                  <Save className="h-3.5 w-3.5" />
                  {updateMutation.isPending || saveErpRestrictionsMutation.isPending ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {user.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate their account. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false);
                requestPasswordConfirmation(() => deleteMutation.mutate(), "Remove User");
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-user"
            >
              {deleteMutation.isPending ? "Removing..." : "Remove User"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {PasswordConfirmationDialog}
    </>
  );
}
