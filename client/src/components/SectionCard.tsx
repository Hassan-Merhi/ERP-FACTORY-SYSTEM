import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

export interface SectionCardProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  noPadding?: boolean;
  children?: React.ReactNode;
  "data-testid"?: string;
}

/**
 * SectionCard — titled container with optional right-rail actions slot.
 * Used to group related content with a consistent header/footer rhythm
 * across all modules.
 */
export function SectionCard({
  title,
  description,
  icon: Icon,
  actions,
  footer,
  className,
  contentClassName,
  noPadding,
  children,
  "data-testid": testId,
}: SectionCardProps) {
  return (
    <Card className={cn("flex flex-col shadow-xs", className)} data-testid={testId}>
      {(title || description || actions) && (
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div className="flex items-start gap-2 min-w-0 flex-1">
            {Icon && (
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary shrink-0 mt-0.5">
                <Icon className="h-4 w-4" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {title && <CardTitle className="text-base sm:text-lg leading-tight">{title}</CardTitle>}
              {description && <CardDescription className="mt-1 text-xs sm:text-sm">{description}</CardDescription>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>}
        </CardHeader>
      )}
      <CardContent className={cn(noPadding ? "p-0" : "pt-0", contentClassName)}>{children}</CardContent>
      {footer && <div className="border-t px-6 py-3 flex items-center justify-end gap-2 flex-wrap">{footer}</div>}
    </Card>
  );
}
