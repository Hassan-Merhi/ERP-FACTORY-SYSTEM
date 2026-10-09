import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { approvalReasonLabel } from "./retailWave2Types";

/**
 * Manager sign-off for a discount above the company limit or a manual price override.
 * The manager types their own ERP credentials; the server re-prices the exact cart,
 * fingerprints it and returns a short-lived token that checkout consumes once.
 */
export function RetailApprovalDialog({
  open,
  reasons,
  pending,
  error,
  onClose,
  onApprove,
}: {
  open: boolean;
  reasons: string[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onApprove: (username: string, password: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent data-testid="retail-approval-dialog">
        <DialogHeader>
          <DialogTitle>Manager approval required</DialogTitle>
          <DialogDescription>
            {reasons.length
              ? reasons.map(approvalReasonLabel).join(" · ")
              : "This discount or price override needs a manager."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="retail-approval-username">Manager username</Label>
            <Input
              id="retail-approval-username"
              autoFocus
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              data-testid="retail-approval-username"
            />
          </div>
          <div>
            <Label htmlFor="retail-approval-password">Manager password</Label>
            <Input
              id="retail-approval-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="retail-approval-password"
            />
          </div>
          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!username.trim() || !password || pending}
            onClick={() => onApprove(username.trim(), password)}
            data-testid="retail-approval-submit"
          >
            {pending ? "Approving…" : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
