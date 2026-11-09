import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MoneyAmount } from "@/components/MoneyAmount";
import type { RentalModule } from "@/properties/config/rentalModulePolicy";
import type { PaymentRow } from "../../RentalPaymentsLog";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function rentalPaymentDeletionImpact(module: RentalModule): string {
  if (module === "PROPERTIES") {
    return "Its associated accounting entries will be retired. Properties receipts do not automatically transfer money to another company; any previously linked transfer, if present, will also be retired. This cannot be undone.";
  }
  return "Its associated accounting entries will be retired. Any linked inter-company transfer, if present, will also be retired in the relevant companies. This cannot be undone.";
}

/** Shared confirmation for all rental modules. Authorization and retirement
 * remain server-owned; this dialog only describes the consequences.
 */
export function RentalPaymentDeleteDialog({
  payment,
  module,
  pending,
  onClose,
  onConfirm,
}: {
  payment: PaymentRow | null;
  module: RentalModule;
  pending: boolean;
  onClose: () => void;
  onConfirm: (id: number) => Promise<unknown>;
}) {
  return (
    <ConfirmDialog
      open={payment !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Delete this payment?"
      tone="destructive"
      confirmText="Yes, Delete Payment"
      confirmButtonTestId="button-confirm-delete-payment"
      loading={pending}
      description={payment ? (
        <>
          This will remove the{" "}
          <strong><MoneyAmount amount={payment.amount} currency={payment.currency ?? "USD"} /></strong>{" "}
          payment from <strong>{payment.tenantName ?? "—"}</strong> ({MONTH_NAMES[payment.forMonth] ?? "—"}{" "}
          {payment.forYear}). {rentalPaymentDeletionImpact(module)}
        </>
      ) : undefined}
      onConfirm={async () => {
        if (payment) await onConfirm(payment.id);
      }}
    />
  );
}
