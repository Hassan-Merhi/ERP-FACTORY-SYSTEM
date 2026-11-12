import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
/**
 * MemberFormDialog — extracted sub-component.
 *
 * Extracted from FactoryInsurance.tsx during the Phase 4 god-file split.
 */
import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { MoneyInput } from "@/components/ui/decimal-input";
import { FormGrid } from "@/components/ui/form";
import { useSingleFlightAction } from "@/hooks/use-single-flight-action";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { InsuranceMember } from "../types";

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
  const recordChanges = useExistingRecordChangeAccess();
  const canSave = existing ? recordChanges.allowed : recordChanges.canCreate("POST", "/api/insurance/members");
  const formId = useId();
  const { execute: executeSave, pending: submitting } = useSingleFlightAction();
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
        if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
    if (submitting || saveMutation.isPending) return;
    if (!name.trim() || !startDate || !amount) {
      toast({ title: "Please fill in required fields", variant: "destructive" });
      return;
    }
    void executeSave(() =>
      saveMutation.mutateAsync({
        name: name.trim(),
        nationality: nationality || null,
        positionWorking: positionWorking || null,
        insuranceNumber: insuranceNumber || null,
        startDate,
        amount,
        dob: dob || null,
        notes: notes || null,
      })
    ).catch(() => {
      // Existing mutation onError shows the error.
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
            <Label htmlFor={`${formId}-name`}>
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              id={`${formId}-name`}
              data-testid="input-member-name"
            />
          </div>
          <FormGrid minColumnWidth="10rem" className="gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${formId}-nationality`}>Nationality</Label>
              <Input
                value={nationality}
                onChange={(e) => setNationality(e.target.value)}
                placeholder="e.g. Congolese"
                id={`${formId}-nationality`}
                data-testid="input-member-nationality"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${formId}-position`}>Position / Working</Label>
              <Input
                value={positionWorking}
                onChange={(e) => setPositionWorking(e.target.value)}
                placeholder="e.g. Operator"
                id={`${formId}-position`}
                data-testid="input-member-position"
              />
            </div>
          </FormGrid>
          <div className="space-y-1">
            <Label htmlFor={`${formId}-insurance`}>Insurance Number</Label>
            <Input
              value={insuranceNumber}
              onChange={(e) => setInsuranceNumber(e.target.value)}
              placeholder="e.g. INS-00123"
              id={`${formId}-insurance`}
              data-testid="input-member-insurance-number"
            />
          </div>
          <FormGrid minColumnWidth="10rem" className="gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${formId}-start`}>
                Start Date <span className="text-destructive">*</span>
              </Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                id={`${formId}-start`}
                data-testid="input-member-startdate"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${formId}-dob`}>Date of Birth</Label>
              <Input
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                id={`${formId}-dob`}
                data-testid="input-member-dob"
              />
            </div>
          </FormGrid>
          <div className="space-y-1">
            <Label htmlFor={`${formId}-amount`}>
              Monthly Amount <span className="text-destructive">*</span>
            </Label>
            <MoneyInput
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              id={`${formId}-amount`}
              data-testid="input-member-amount"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${formId}-notes`}>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
              className="resize-none"
              rows={2}
              id={`${formId}-notes`}
              data-testid="input-member-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-member">
            Cancel
          </Button>
          {canSave && (
            <FormSubmitButton
              type="button"
              onClick={handleSubmit}
              pending={submitting || saveMutation.isPending}
              pendingLabel="Saving…"
              data-testid="button-save-member"
            >
              {existing ? "Save Changes" : "Add Member"}
            </FormSubmitButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Member Statement Drawer ──────────────────────────────────────────────────
