import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SettingsUserRow } from "./settingsTypes";

interface PasswordResetDialogProps {
  user: SettingsUserRow | null;
  onClose: () => void;
  onReset: (userId: string, newPassword: string) => void;
  newPassword: string;
  onPasswordChange: (val: string) => void;
  isPending: boolean;
}

export function PasswordResetDialog({
  user,
  onClose,
  onReset,
  newPassword,
  onPasswordChange,
  isPending,
}: PasswordResetDialogProps) {
  if (!user) return null;

  return (
    <Dialog open={!!user} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>
            Enter a new password for <strong>{user.username}</strong>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder="Min 6 characters"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => onReset(user.id, newPassword)}
            disabled={!newPassword || newPassword.length < 6 || isPending}
          >
            {isPending ? "Resetting..." : "Reset Password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
