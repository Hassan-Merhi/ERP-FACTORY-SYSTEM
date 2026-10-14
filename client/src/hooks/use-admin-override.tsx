import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdminOverrideDialog } from "@/components/AdminOverrideDialog";

const ADMIN_ROLES = ["Admin", "Owner", "Developer"];

interface CurrentUser {
  role?: string | null;
}

/**
 * Module-level cache — when a non-admin successfully verifies admin credentials,
 * we remember it for 5 minutes so they don't have to re-enter on every action.
 * This resets on full page reload which is intentional.
 */
let adminOverrideGrantedUntil = 0;

export function setAdminOverrideCache() {
  adminOverrideGrantedUntil = Date.now() + 5 * 60 * 1000;
}

interface UseAdminOverrideReturn {
  wrapAdminAction: (fn: () => void, label?: string) => void;
  AdminDialog: React.ReactNode;
}

/**
 * useAdminOverride — wraps any destructive factory action with an admin
 * credential check.
 *
 * - If the current user is already Admin/Owner/Developer, the action fires immediately.
 * - If a non-admin recently verified admin credentials (within 5 min), fires immediately.
 * - Otherwise shows the Admin Authorization dialog asking for admin credentials.
 *   On success the action fires and the 5-minute cache is set.
 *
 * Usage:
 *   const { wrapAdminAction, AdminDialog } = useAdminOverride();
 *   // Somewhere in JSX: {AdminDialog}
 *   // On a button: onClick={() => wrapAdminAction(() => deleteMutation.mutate(id), "Delete Item")}
 */
export function useAdminOverride(): UseAdminOverrideReturn {
  const { data: currentUser } = useQuery<CurrentUser>({ queryKey: ["/api/auth/me"] });

  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [actionLabel, setActionLabel] = useState<string | undefined>(undefined);

  const isAdmin = ADMIN_ROLES.includes(currentUser?.role || "");

  const wrapAdminAction = useCallback(
    (fn: () => void, label?: string) => {
      if (isAdmin || Date.now() < adminOverrideGrantedUntil) {
        fn();
      } else {
        setActionLabel(label);
        setPendingAction(() => fn);
      }
    },
    [isAdmin]
  );

  const handleSuccess = useCallback(() => {
    const action = pendingAction;
    setPendingAction(null);
    setActionLabel(undefined);
    setAdminOverrideCache();
    if (action) action();
  }, [pendingAction]);

  const handleCancel = useCallback(() => {
    setPendingAction(null);
    setActionLabel(undefined);
  }, []);

  const AdminDialog = (
    <AdminOverrideDialog
      open={!!pendingAction}
      actionLabel={actionLabel}
      onSuccess={handleSuccess}
      onCancel={handleCancel}
    />
  );

  return { wrapAdminAction, AdminDialog };
}
