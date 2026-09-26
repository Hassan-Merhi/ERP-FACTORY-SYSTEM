import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { cn } from "@/lib/utils";

export interface VoucherPhoneActionBarProps {
  /** Totals line (for example "Dr $120 · Cr $120" or "3 items · 40 qty"). */
  summary: ReactNode;
  /** Validation state shown beside the totals; omitted when the voucher has no balance rule. */
  status?: { ok: boolean; label: ReactNode };
  saveLabel: string;
  savingLabel?: string;
  saving?: boolean;
  disabled?: boolean;
  /**
   * Save handler. When omitted the button submits the enclosing form, so the form's own
   * validation and submit handler run exactly as for the desktop Save button.
   */
  onSave?: () => void;
  /** Leaves the editor (edit mode). Omitted for a new voucher, which has nothing to cancel to. */
  onCancel?: () => void;
  /** Extra actions above the totals (for example Save as Revision). */
  extra?: ReactNode;
  "data-testid"?: string;
}

/**
 * Phone save bar shared by every voucher form. It sticks to the bottom of the scroll area with
 * the running totals, the validation state and Cancel | Save, so a long voucher never hides its
 * Save button. It only renders on ERP phone layouts; forms keep their own action row on tablet
 * and desktop and hide it on phones, so there is always exactly one Save.
 */
export function VoucherPhoneActionBar({
  summary,
  status,
  saveLabel,
  savingLabel = "Saving...",
  saving = false,
  disabled = false,
  onSave,
  onCancel,
  extra,
  "data-testid": testId = "voucher-phone-action-bar",
}: VoucherPhoneActionBarProps) {
  const isPhone = useErpPhoneLayout();
  if (!isPhone) return null;

  return (
    <div
      className="sticky bottom-0 z-20 -mx-3 mt-4 space-y-2 border-t bg-background px-3 pb-[max(0.75rem,var(--safe-area-bottom))] pt-2 shadow-[0_-4px_12px_-8px_hsl(var(--foreground)/0.25)]"
      data-testid={testId}
      data-voucher-sticky-actions=""
    >
      {extra && <div className="flex flex-wrap gap-2 [&>*]:flex-1">{extra}</div>}
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <div className="min-w-0 truncate font-mono tabular-nums text-muted-foreground" dir="ltr">
          {summary}
        </div>
        {status && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-1 font-medium",
              status.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"
            )}
            data-testid={`${testId}-status`}
          >
            {status.ok ? (
              <CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {status.label}
          </div>
        )}
      </div>
      <div className={cn("grid gap-2", onCancel ? "grid-cols-2" : "grid-cols-1")}>
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onCancel}
            data-testid={`${testId}-cancel`}
          >
            Cancel
          </Button>
        )}
        <Button
          type={onSave ? "button" : "submit"}
          onClick={onSave}
          disabled={disabled || saving}
          className="min-h-11"
          data-testid={`${testId}-save`}
        >
          {saving ? savingLabel : saveLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Cancel for a voucher opened in edit mode: returns to where the user came from (Daybook, All
 * Daybook, a statement), like the page Back control. A new voucher has no Cancel.
 */
export function useVoucherEditCancel(isEditing: boolean): (() => void) | undefined {
  const back = useBackToParent("/daybook");
  return isEditing ? back : undefined;
}
