import { useId, useRef, type ReactNode } from "react";
import { AlertTriangle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { cn } from "@/lib/utils";
import { VoucherPhoneActionBar, useVoucherEditCancel } from "./VoucherPhoneActionBar";
import { useVoucherShortcuts, voucherShortcutLabels } from "./useVoucherShortcuts";

/** The one pair of save labels every voucher form uses. */
export const VOUCHER_SAVE_LABEL = "Save Voucher";
export const VOUCHER_UPDATE_LABEL = "Update Voucher";
export const VOUCHER_SAVING_LABEL = "Saving…";
export const VOUCHER_UPDATING_LABEL = "Updating…";

export function voucherSaveLabel(isEditing: boolean, saving = false): string {
  if (saving) return isEditing ? VOUCHER_UPDATING_LABEL : VOUCHER_SAVING_LABEL;
  return isEditing ? VOUCHER_UPDATE_LABEL : VOUCHER_SAVE_LABEL;
}

export interface VoucherActionBarProps {
  /** Editing an existing voucher: Update label, Cancel button and Esc. */
  isEditing: boolean;
  saving?: boolean;
  disabled?: boolean;
  /**
   * Save handler. When omitted Save submits the enclosing form, so the form's own validation and
   * submit handler run unchanged.
   */
  onSave?: () => void;
  /**
   * Cancel for an edit. Defaults to returning where the voucher was opened from (the Daybook or a
   * statement). Ignored for a new voucher, which has no Cancel.
   */
  onCancel?: () => void;
  /** Running totals, left of the buttons. */
  summary?: ReactNode;
  /** Shorter totals line for the phone bar; defaults to `summary`. */
  phoneSummary?: ReactNode;
  /** Validation state shown beside the totals. */
  status?: { ok: boolean; label: ReactNode };
  /** Validation state for the phone bar only, for forms that already show it on the page. */
  phoneStatus?: { ok: boolean; label: ReactNode };
  /** The voucher's Optional control. */
  optional?: ReactNode;
  /** Secondary actions (Export, Save as Revision, Validate…), placed before Cancel and Save. */
  secondary?: ReactNode;
  /** Why Save is disabled, said out loud under the button. */
  hint?: ReactNode;
  /** Test id of the Save button; each form keeps its existing one. */
  saveTestId?: string;
  /** Extra class for the Save button (the POS skin of the stock transfer form). */
  saveClassName?: string;
  "data-testid"?: string;
  className?: string;
}

/**
 * The action bar of every voucher form (Payment, Receipt, Journal, Stock Transfer, Transfer Order,
 * Production / Consumption, Credit / Debit Note), new or opened from the Daybook Edit button.
 *
 * Desktop: sticky footer with the totals on the left and Optional · secondary actions · Cancel ·
 * Save on the right. Phones: the shared `VoucherPhoneActionBar`. One save label pair
 * (Save Voucher / Update Voucher), Cancel only when editing, and one shortcut set
 * (Ctrl/⌘+Enter save, Esc cancel) shown as hints on the buttons.
 */
export function VoucherActionBar({
  isEditing,
  saving = false,
  disabled = false,
  onSave,
  onCancel,
  summary,
  phoneSummary,
  status,
  phoneStatus,
  optional,
  secondary,
  hint,
  saveTestId = "button-save-voucher",
  saveClassName,
  "data-testid": testId = "voucher-action-bar",
  className,
}: VoucherActionBarProps) {
  const isPhone = useErpPhoneLayout();
  const containerRef = useRef<HTMLDivElement>(null);
  const backToParent = useVoucherEditCancel(isEditing);
  const cancel = isEditing ? (onCancel ?? backToParent) : undefined;
  const keys = voucherShortcutLabels();

  // The shortcut clicks the visible Save button, so it saves exactly as a click would: through the
  // form's submit handler, and not at all while Save is disabled.
  useVoucherShortcuts({
    onSave: () => {
      const button = containerRef.current?.querySelector<HTMLButtonElement>("[data-voucher-save]");
      if (button && !button.disabled) button.click();
    },
    onCancel: cancel,
  });

  const label = voucherSaveLabel(isEditing);
  const pendingLabel = voucherSaveLabel(isEditing, true);

  if (isPhone) {
    return (
      <div ref={containerRef} className="contents">
        <VoucherPhoneActionBar
          summary={phoneSummary ?? summary}
          status={phoneStatus ?? status}
          saveLabel={label}
          savingLabel={pendingLabel}
          saving={saving}
          disabled={disabled}
          onSave={onSave}
          onCancel={cancel}
          extra={
            optional || secondary ? (
              <>
                {optional}
                {secondary}
              </>
            ) : undefined
          }
          data-testid={testId}
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="contents">
      <div
        className={cn(
          "voucher-action-bar sticky bottom-0 z-20 mt-4 rounded-b-lg border-t bg-card px-4 py-3 shadow-[0_-4px_12px_-8px_hsl(var(--foreground)/0.25)] sm:px-5",
          className
        )}
        data-testid={testId}
        data-voucher-sticky-actions=""
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            {summary && <div className="min-w-0">{summary}</div>}
            {status && (
              <div
                className={cn(
                  "flex shrink-0 items-center gap-1 text-xs font-medium",
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

          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">
            {optional}
            {secondary}
            {cancel && (
              <Button
                type="button"
                variant="outline"
                onClick={cancel}
                title={`Cancel (${keys.cancel})`}
                aria-keyshortcuts="Escape"
                data-testid={`${testId}-cancel`}
              >
                Cancel
                <kbd
                  aria-hidden="true"
                  className="ml-2 rounded-sm bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground"
                >
                  {keys.cancel}
                </kbd>
              </Button>
            )}
            <div className="flex flex-col items-end gap-1">
              <Button
                type={onSave ? "button" : "submit"}
                onClick={onSave}
                disabled={disabled || saving}
                aria-busy={saving || undefined}
                title={`${label} (${keys.save})`}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                className={cn("voucher-save-button", saveClassName)}
                data-voucher-save=""
                data-testid={saveTestId}
              >
                {saving ? pendingLabel : label}
                {!saving && (
                  <kbd
                    aria-hidden="true"
                    className="ml-2 rounded-sm bg-primary-foreground/20 px-1 py-0.5 text-[10px] font-normal"
                  >
                    {keys.save}
                  </kbd>
                )}
              </Button>
              {hint && (
                <span className="text-[11px] text-muted-foreground" data-testid={`${testId}-hint`}>
                  {hint}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface VoucherOptionalSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "data-testid"?: string;
}

/** The voucher's "Optional" control, one switch and one label in every form's action bar. */
export function VoucherOptionalSwitch({
  checked,
  onCheckedChange,
  disabled = false,
  "data-testid": testId,
}: VoucherOptionalSwitchProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-2" title="Excluded from required balance checks">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} data-testid={testId} />
      <Label htmlFor={id} className="cursor-pointer text-xs font-normal text-muted-foreground">
        Optional
      </Label>
    </div>
  );
}
