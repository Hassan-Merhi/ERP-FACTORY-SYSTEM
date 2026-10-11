/**
 * Phase 29: the "Reverse" action offered when a voucher edit is refused with
 * 409 VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD (a voucher dated in a closed
 * period is corrected by reversal, never edited). The refusal names the
 * reverse route; the action asks for the reason and posts
 * POST /api/vouchers/:id/reverse, dated on the company's business date by the
 * server (refused there if that date is closed too).
 */
import { ToastAction } from "@/components/ui/toast";
import { toast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export const VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD = "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD";

interface CorrectionRefusal {
  code?: unknown;
  status?: unknown;
  message?: string;
}

export function isClosedPeriodReverseInstead(error: unknown): boolean {
  const refusal = error as CorrectionRefusal | null;
  return refusal?.code === VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD;
}

async function reverseVoucher(voucherId: number): Promise<void> {
  const reason = window.prompt("Reason for the reversal");
  if (!reason || !reason.trim()) return;
  try {
    await apiRequest("POST", `/api/vouchers/${voucherId}/reverse`, { reason: reason.trim() });
    await queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
    await queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    toast({ title: "Voucher reversed", description: "Post the corrected voucher in an open period." });
  } catch (error: unknown) {
    toast({
      title: "Could not reverse the voucher",
      description: error instanceof Error ? error.message : String(error),
      variant: "destructive",
    });
  }
}

/**
 * Shows the refusal with a Reverse action when `error` is the closed-period
 * refusal; returns false (nothing shown) for any other error.
 */
export function offerReverseInstead(error: unknown, voucherId: number | null | undefined): boolean {
  if (!voucherId || !isClosedPeriodReverseInstead(error)) return false;
  toast({
    title: "Closed period",
    description: (error as CorrectionRefusal).message,
    variant: "destructive",
    action: (
      <ToastAction altText="Reverse" onClick={() => void reverseVoucher(voucherId)}>
        Reverse
      </ToastAction>
    ),
  });
  return true;
}
