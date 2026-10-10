import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  // Whitespace-nowrap: Badges should never wrap.
  "whitespace-nowrap inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2" +
    " hover-elevate ",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow-2xs",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground shadow-2xs",
        outline: " border border-(--badge-outline) shadow-2xs",

        // Semantic status variants — soft fills with matching foreground.
        // Use these instead of ad-hoc bg-green-100/text-green-700 etc. so
        // dark-mode and theme tokens stay consistent.
        success: "border-transparent bg-success-soft text-success-soft-foreground",
        warning: "border-transparent bg-warning-soft text-warning-soft-foreground",
        info: "border-transparent bg-info-soft text-info-soft-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
