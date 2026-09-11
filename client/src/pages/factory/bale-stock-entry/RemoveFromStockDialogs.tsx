import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkerOption } from "./RemoveFromStockTab";

interface RemoveBaleAuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  supervisorUsername: string;
  onSupervisorUsernameChange: (val: string) => void;
  supervisorPassword: string;
  onSupervisorPasswordChange: (val: string) => void;
  removalReason: string;
  onRemovalReasonChange: (val: string) => void;
  authError: string;
  isPending: boolean;
  onConfirm: () => void;
}

export function RemoveBaleAuthDialog({
  open,
  onOpenChange,
  selectedCount,
  supervisorUsername,
  onSupervisorUsernameChange,
  supervisorPassword,
  onSupervisorPasswordChange,
  removalReason,
  onRemovalReasonChange,
  authError,
  isPending,
  onConfirm,
}: RemoveBaleAuthDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-5 w-5" />
            Supervisor Authorization Required
          </DialogTitle>
          <DialogDescription>
            Removing {selectedCount} bale(s) from stock requires supervisor approval and a valid reason.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Supervisor Username</label>
            <Input
              value={supervisorUsername}
              onChange={(e) => onSupervisorUsernameChange(e.target.value)}
              placeholder="Supervisor username"
              data-testid="input-supervisor-username"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Supervisor Password</label>
            <Input
              type="password"
              value={supervisorPassword}
              onChange={(e) => onSupervisorPasswordChange(e.target.value)}
              placeholder="Supervisor password"
              data-testid="input-supervisor-password"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Reason for Removal</label>
            <Input
              value={removalReason}
              onChange={(e) => onRemovalReasonChange(e.target.value)}
              placeholder="e.g. Recycled, Correction, Damage"
              data-testid="input-removal-reason"
            />
          </div>
          {authError && <p className="text-xs font-medium text-destructive">{authError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={!supervisorUsername || !supervisorPassword || !removalReason || isPending}
            data-testid="button-auth-remove"
          >
            {isPending ? "Processing..." : "Authorize & Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AssignWorkerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workers: WorkerOption[];
  workerIdSelected: string;
  onWorkerIdChange: (val: string) => void;
  isPending: boolean;
  onConfirm: () => void;
}

export function AssignWorkerDialog({
  open,
  onOpenChange,
  workers,
  workerIdSelected,
  onWorkerIdChange,
  isPending,
  onConfirm,
}: AssignWorkerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Worker to Bale</DialogTitle>
          <DialogDescription>
            This bale has no worker assigned. Please select the worker who finalized this bale before printing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Worker Name</label>
            <Select value={workerIdSelected} onValueChange={onWorkerIdChange}>
              <SelectTrigger data-testid="select-print-worker">
                <SelectValue placeholder="Select worker..." />
              </SelectTrigger>
              <SelectContent>
                {workers
                  .filter((w) => w.active !== false)
                  .map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.fullName || w.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!workerIdSelected || isPending} data-testid="button-assign-print">
            {isPending ? "Assigning..." : "Assign & Print"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
