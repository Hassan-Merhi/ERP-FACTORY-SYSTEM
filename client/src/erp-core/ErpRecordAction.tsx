import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * Standard non-submitting row action. The owning page supplies its existing
 * permission decision, and the server remains authoritative for mutations.
 * Denied actions are natively disabled; the reason is exposed as a tooltip.
 */
export interface ErpRecordActionProps extends ButtonProps {
  permitted?: boolean;
  deniedReason?: string | null;
}

export const ErpRecordAction = React.forwardRef<HTMLButtonElement, ErpRecordActionProps>(
  (
    { permitted = true, deniedReason, disabled, title, type = "button", variant = "ghost", ...props },
    ref
  ) => (
    <Button
      ref={ref}
      type={type}
      variant={variant}
      disabled={disabled || !permitted}
      title={title ?? (!permitted ? deniedReason ?? undefined : undefined)}
      {...props}
    />
  )
);
ErpRecordAction.displayName = "ErpRecordAction";
