import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AlertPanel } from "@/components/AlertPanel";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

interface AdminOverrideDialogProps {
  open: boolean;
  actionLabel?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * AdminOverrideDialog — verifies admin credentials against
 * `/api/factory/admin-verify` before invoking `onSuccess`. Built on top of
 * the canonical {@link ConfirmDialog} primitive.
 */
export function AdminOverrideDialog({ open, actionLabel, onSuccess, onCancel }: AdminOverrideDialogProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  // The override only unlocks a change to an existing record, which read-only roles never make.
  const recordChanges = useExistingRecordChangeAccess();

  useEffect(() => {
    if (!open) {
      setUsername("");
      setPassword("");
      setErrorMsg("");
    }
  }, [open]);

  const verifyMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/admin-verify", {
        username: username.trim(),
        password,
      });
      return res.json();
    },
  });

  const handleConfirm = async () => {
    setErrorMsg("");
    if (!username.trim() || !password) {
      setErrorMsg("Please enter both username and password.");
      throw new Error("validation");
    }
    try {
      await verifyMutation.mutateAsync();
      onSuccess();
    } catch (err) {
      setPassword("");
      setErrorMsg(getErrorDetails(err).optionalMessage || "Invalid credentials. Please try again.");
      throw err;
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) onCancel();
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Admin Authorization Required"
      description={
        actionLabel
          ? `"${actionLabel}" requires admin access. Please enter admin credentials to proceed.`
          : "This action requires admin access. Please enter admin credentials to proceed."
      }
      icon={ShieldAlert}
      tone="warning"
      confirmText={verifyMutation.isPending ? "Verifying..." : "Confirm"}
      confirmDisabled={!recordChanges.allowed || !username.trim() || !password}
      loading={verifyMutation.isPending}
      onConfirm={handleConfirm}
      onCancel={onCancel}
      data-testid="dialog-admin-override"
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="admin-override-username">Admin Username</Label>
          <Input
            id="admin-override-username"
            data-testid="input-admin-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="off"
            disabled={verifyMutation.isPending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="admin-override-password">Admin Password</Label>
          <Input
            id="admin-override-password"
            data-testid="input-admin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            disabled={verifyMutation.isPending}
          />
        </div>
        {recordChanges.reason && (
          <AlertPanel tone="warning" description={recordChanges.reason} data-testid="text-admin-override-read-only" />
        )}
        {errorMsg && <AlertPanel tone="destructive" description={errorMsg} data-testid="text-admin-override-error" />}
      </div>
    </ConfirmDialog>
  );
}
