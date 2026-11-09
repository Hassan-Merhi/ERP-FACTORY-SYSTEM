import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { FormActionBar } from "@/components/ui/workspace-layout";
import { cn } from "@/lib/utils";

/** Shared ERP action-footer layouts. Dialog uses existing phone-sheet behavior. */
export interface ErpFormActionsProps extends React.HTMLAttributes<HTMLDivElement> {
  layout?: "dialog" | "inline" | "sticky";
}

export function ErpFormActions({ layout = "inline", className, ...props }: ErpFormActionsProps) {
  if (layout === "dialog") return <DialogFooter className={className} data-erp-form-actions="" {...props} />;
  if (layout === "sticky") return <FormActionBar className={className} data-erp-form-actions="" {...props} />;
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2 pt-2", className)}
      data-erp-form-actions=""
      {...props}
    />
  );
}

/**
 * A safe save/submit action. Existing Button owns spinner, busy semantics,
 * and native disabled behavior; pending operations cannot fire twice.
 * `type="button"` is intentional outside a form; forms opt into submit.
 */
export interface ErpPendingButtonProps extends Omit<ButtonProps, "isLoading" | "loadingLabel" | "asChild"> {
  pending?: boolean;
  pendingLabel?: string;
}

export const ErpPendingButton = React.forwardRef<HTMLButtonElement, ErpPendingButtonProps>(
  ({ type = "button", pending = false, pendingLabel = "Saving…", disabled, children, ...props }, ref) => (
    <Button
      ref={ref}
      type={type}
      disabled={disabled || pending}
      isLoading={pending}
      loadingLabel={pendingLabel}
      {...props}
    >
      {children}
    </Button>
  )
);
ErpPendingButton.displayName = "ErpPendingButton";
