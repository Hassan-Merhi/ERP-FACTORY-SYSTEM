// Extracted from ./FxAgentEurStatement.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { apiRequest } from "@/lib/queryClient";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import type { PeriodFilterValue } from "@/components/ui/period-filter";

interface EurOperation {
  id: number;
  date: string;
  kind: string;
  description: string;
  detail: string;
  eurIn: string;
  eurOut: string;
  balance: string;
  rateUsdPerEur: string;
  voucherId: number | null;
  deleted?: boolean;
}

interface EurStatement {
  accountName: string;
  activatedOn: string;
  fromDate: string | null;
  toDate: string;
  openingEur: string;
  totalEurIn: string;
  totalEurOut: string;
  closingEur: string;
  rows: EurOperation[];
}

export const eur = (amount: string) =>
  Number(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });

export function fxEurStatementUrl(walletId: number, period: PeriodFilterValue, extension = "", showDeleted = false) {
  const params = new URLSearchParams();
  if (period.fromDate) params.set("startDate", period.fromDate);
  if (period.toDate) params.set("endDate", period.toDate);
  if (showDeleted) params.set("showDeleted", "true");
  return "/api/factory/fx-agent-wallets/" + walletId + "/statement" + extension + "?" + params.toString();
}

export function useFxAgentEurStatementState({
  walletId,
  periodFilter,
  hideBalances,
}: {
  walletId: number;
  periodFilter: PeriodFilterValue;
  hideBalances: boolean;
}) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recordChanges = useExistingRecordChangeAccess();
  const [showDeleted, setShowDeleted] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reverseId, setReverseId] = useState<number | null>(null);
  const [reverseReason, setReverseReason] = useState("");

  const { data, isPending, error } = useQuery<EurStatement>({
    queryKey: [
      "fx-agent-eur-statement",
      selectedCompany?.id,
      walletId,
      periodFilter.fromDate || null,
      periodFilter.toDate || null,
      showDeleted,
    ],
    queryFn: async () => {
      const response = await fetch(fxEurStatementUrl(walletId, periodFilter, "", showDeleted), {
        credentials: "include",
      });
      if (!response.ok) {
        const issue = await response.json().catch(() => null);
        throw new Error(issue?.message || "Could not load EUR movements");
      }
      return response.json();
    },
    enabled: walletId > 0 && !!selectedCompany?.id,
    staleTime: 0,
  });

  const selectable = useMemo(
    () =>
      recordChanges.allowed
        ? (data?.rows || []).filter((op) => op.kind === "EUR_SETTLEMENT" && !op.deleted && op.voucherId != null)
        : [],
    [data?.rows, recordChanges.allowed]
  );
  const selectedPayments = selectable.filter((op) => selectedIds.has(op.id));
  const allSelected = selectable.length > 0 && selectedPayments.length === selectable.length;
  const toggle = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const invalidateFx = () => {
    queryClient.invalidateQueries({ queryKey: ["fx-agent-eur-statement"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-agent-wallets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
    queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
    queryClient.invalidateQueries({ queryKey: ["account-statement"] });
    queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
    setSelectedIds(new Set());
  };
  const deleteMutation = useMutation({
    // FX EUR payment vouchers must be deleted individually: the generic bulk
    // endpoint deliberately rejects wallet-linked vouchers.
    mutationFn: async (voucherIds: number[]) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      let deleted = 0;
      for (const id of voucherIds) {
        try {
          await apiRequest("DELETE", "/api/vouchers/" + id);
          deleted++;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          throw new Error(deleted + " of " + voucherIds.length + " payment(s) deleted. " + message, { cause: error });
        }
      }
      return deleted;
    },
    onSuccess: (count) =>
      toast({
        title: count + " EUR payment(s) deleted",
        description: "EUR restored; linked USD postings and FX gain/loss reversed.",
      }),
    onError: (error: Error) =>
      toast({ title: "EUR payment deletion failed", description: error.message, variant: "destructive" }),
    onSettled: () => {
      invalidateFx();
      setConfirmDelete(false);
    },
  });
  const reverseMutation = useMutation({
    mutationFn: async (params: { conversionId: number; reason: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("POST", "/api/factory/fx-agent-wallets/" + walletId + "/reverse-conversion", {
        conversionId: params.conversionId,
        reason: params.reason,
        requestKey: "eur-ledger-reverse-" + params.conversionId + "-" + Date.now(),
      });
    },
    onSuccess: () => {
      toast({ title: "EUR conversion reversed", description: "Original USD basis restored to the wallet." });
      invalidateFx();
      setReverseId(null);
      setReverseReason("");
    },
    onError: (error: Error) =>
      toast({ title: "Conversion reversal failed", description: error.message, variant: "destructive" }),
  });
  return {
    allSelected,
    confirmDelete,
    data,
    deleteMutation,
    error,
    hideBalances,
    isPending,
    periodFilter,
    recordChanges,
    reverseId,
    reverseMutation,
    reverseReason,
    selectable,
    selectedIds,
    selectedPayments,
    setConfirmDelete,
    setReverseId,
    setReverseReason,
    setSelectedIds,
    setShowDeleted,
    showDeleted,
    toggle,
    walletId,
  };
}

export function FxAgentEurStatementDialogSection({
  reverseId,
  reverseMutation,
  reverseReason,
  setReverseId,
  setReverseReason,
}: Pick<
  ReturnType<typeof useFxAgentEurStatementState>,
  "reverseId" | "reverseMutation" | "reverseReason" | "setReverseId" | "setReverseReason"
>) {
  return (
    <Dialog
      open={reverseId != null}
      onOpenChange={(open) => {
        if (!open && !reverseMutation.isPending) {
          setReverseId(null);
          setReverseReason("");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse EUR conversion</DialogTitle>
          <DialogDescription>
            Restores the original USD amount and deducts the matching EUR. A conversion cannot be reversed after any
            later EUR settlement.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reverseReason}
          onChange={(event) => setReverseReason(event.target.value)}
          maxLength={500}
          placeholder="Reason for reversing this conversion"
          data-testid="fx-agent-eur-reverse-reason"
        />
        <DialogFooter>
          <Button variant="outline" disabled={reverseMutation.isPending} onClick={() => setReverseId(null)}>
            Cancel
          </Button>
          <Button
            disabled={reverseMutation.isPending || !reverseReason.trim() || reverseId == null}
            onClick={() => {
              if (reverseId != null) reverseMutation.mutate({ conversionId: reverseId, reason: reverseReason.trim() });
            }}
            data-testid="fx-agent-eur-confirm-reverse"
          >
            {reverseMutation.isPending ? "Reversing..." : "Reverse Conversion"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FxAgentEurStatementAlertDialogSection({
  confirmDelete,
  deleteMutation,
  selectedPayments,
  setConfirmDelete,
}: Pick<
  ReturnType<typeof useFxAgentEurStatementState>,
  "confirmDelete" | "deleteMutation" | "selectedPayments" | "setConfirmDelete"
>) {
  return (
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {selectedPayments.length} EUR payment(s)?</AlertDialogTitle>
          <AlertDialogDescription>
            This cancels each linked payment voucher, restores its exact EUR amount to the FX wallet and removes its USD
            and FX gain/loss from active balances. The deleted payment remains in the audit trail. Conversions must be
            reversed separately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={deleteMutation.isPending || selectedPayments.length === 0}
            onClick={(event) => {
              event.preventDefault();
              deleteMutation.mutate(selectedPayments.map((op) => op.voucherId!));
            }}
            data-testid="fx-agent-eur-confirm-delete"
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete Payments"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
