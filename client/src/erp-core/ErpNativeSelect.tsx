import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Accessible native select for compact report filters and legacy forms.
 * Interactive dropdowns can continue using the existing Radix Select when
 * they need combobox, search, or popover behavior.
 */
export const ErpNativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
);
ErpNativeSelect.displayName = "ErpNativeSelect";
