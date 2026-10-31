import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AttendanceAdminCredentials } from "../attendanceEditPolicy";

export function AttendanceAdminApprovalDialog({
  open, onOpenChange, onApprove, isPending, dates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove: (credentials: AttendanceAdminCredentials) => void;
  isPending: boolean;
  dates: string[];
}) {
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  useEffect(() => {
    if (!open) { setAdminUsername(""); setAdminPassword(""); }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isPending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-attendance-admin-approval">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Admin approval required
          </DialogTitle>
          <DialogDescription>
            Earlier attendance is locked. An active Admin for this factory company must enter their
            own username and password to authorize this save.
            {dates.length > 0 && (
              <span className="mt-2 block font-medium">
                {dates.length === 1 ? `Date: ${dates[0]}` : `${dates.length} earlier dates (${dates[0]} to ${dates[dates.length - 1]})`}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (adminUsername.trim() && adminPassword && !isPending) {
            onApprove({ adminUsername: adminUsername.trim(), adminPassword });
          }
        }} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="attendance-approver-username">Admin username</Label>
            <Input id="attendance-approver-username" autoComplete="off" required maxLength={191}
              value={adminUsername} onChange={(event) => setAdminUsername(event.target.value)}
              data-testid="input-attendance-admin-username" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="attendance-approver-password">Admin password</Label>
            <Input id="attendance-approver-password" type="password" autoComplete="off" required
              value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)}
              data-testid="input-attendance-admin-password" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={isPending || !adminUsername.trim() || !adminPassword}
              data-testid="button-confirm-attendance-admin-approval">
              {isPending ? "Verifying and saving…" : "Approve & save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
