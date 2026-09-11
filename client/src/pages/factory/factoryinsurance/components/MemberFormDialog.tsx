import type { ClientErrorLike } from "@/lib/clientError";
/**
 * MemberFormDialog — extracted sub-component.
 *
 * Extracted from FactoryInsurance.tsx during the Phase 4 god-file split.
 */
import {useState} from "react";
import {useMutation} from "@tanstack/react-query";
import {Loader2} from "lucide-react";
import {useToast} from "@/hooks/use-toast";
import {queryClient, apiRequest} from "@/lib/queryClient";
import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import type {InsuranceMember} from "../types";

export // ─── Member Form Dialog ───────────────────────────────────────────────────────
function MemberFormDialog({
  open,
  onClose,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  existing?: InsuranceMember | null;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? "");
  const [nationality, setNationality] = useState(existing?.nationality ?? "");
  const [positionWorking, setPositionWorking] = useState(existing?.positionWorking ?? "");
  const [insuranceNumber, setInsuranceNumber] = useState(existing?.insuranceNumber ?? "");
  const [startDate, setStartDate] = useState(existing?.startDate ?? "");
  const [amount, setAmount] = useState(existing?.amount ?? "");
  const [dob, setDob] = useState(existing?.dob ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");

  const saveMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      nationality: string | null;
      positionWorking: string | null;
      insuranceNumber: string | null;
      startDate: string;
      amount: string;
      dob: string | null;
      notes: string | null;
    }) => {
      if (existing) {
        return apiRequest("PATCH", `/api/insurance/members/${existing.id}`, data);
      } else {
        return apiRequest("POST", "/api/insurance/members", data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/insurance/members"] });
      toast({ title: existing ? "Member updated" : "Member added" });
      onClose();
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!name.trim() || !startDate || !amount) {
      toast({ title: "Please fill in required fields", variant: "destructive" });
      return;
    }
    saveMutation.mutate({
      name: name.trim(),
      nationality: nationality || null,
      positionWorking: positionWorking || null,
      insuranceNumber: insuranceNumber || null,
      startDate,
      amount,
      dob: dob || null,
      notes: notes || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit Member" : "Add Insurance Member"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              data-testid="input-member-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Nationality</Label>
              <Input
                value={nationality}
                onChange={(e) => setNationality(e.target.value)}
                placeholder="e.g. Congolese"
                data-testid="input-member-nationality"
              />
            </div>
            <div className="space-y-1">
              <Label>Position / Working</Label>
              <Input
                value={positionWorking}
                onChange={(e) => setPositionWorking(e.target.value)}
                placeholder="e.g. Operator"
                data-testid="input-member-position"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Insurance Number</Label>
            <Input
              value={insuranceNumber}
              onChange={(e) => setInsuranceNumber(e.target.value)}
              placeholder="e.g. INS-00123"
              data-testid="input-member-insurance-number"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>
                Start Date <span className="text-destructive">*</span>
              </Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                data-testid="input-member-startdate"
              />
            </div>
            <div className="space-y-1">
              <Label>Date of Birth</Label>
              <Input type="date" value={dob} onChange={(e) => setDob(e.target.value)} data-testid="input-member-dob" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>
              Monthly Amount <span className="text-destructive">*</span>
            </Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              data-testid="input-member-amount"
            />
          </div>
          <div className="space-y-1">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
              className="resize-none"
              rows={2}
              data-testid="input-member-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-member">
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saveMutation.isPending} data-testid="button-save-member">
            {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {existing ? "Save Changes" : "Add Member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Member Statement Drawer ──────────────────────────────────────────────────
