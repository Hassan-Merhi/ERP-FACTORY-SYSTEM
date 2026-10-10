import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type ModuleIdentityTone = "erp" | "factory" | "pos" | "properties";

type ModuleIdentityProps = React.HTMLAttributes<HTMLDivElement> & {
  productName?: string;
  moduleName: string;
  description?: string;
  companyName?: string;
  icon: LucideIcon;
  tone?: ModuleIdentityTone;
  compact?: boolean;
};

const toneClasses: Record<ModuleIdentityTone, string> = {
  erp: "border-primary/20 bg-primary/5 text-primary",
  factory:
    "border-[hsl(var(--module-factory)/0.22)] bg-[hsl(var(--module-factory)/0.08)] text-[hsl(var(--module-factory))]",
  pos: "border-[hsl(var(--module-pos)/0.22)] bg-[hsl(var(--module-pos)/0.08)] text-[hsl(var(--module-pos))]",
  properties:
    "border-[hsl(var(--module-properties)/0.22)] bg-[hsl(var(--module-properties)/0.08)] text-[hsl(var(--module-properties))]",
};

export function ModuleIdentity({
  productName = "Business OS",
  moduleName,
  description,
  companyName,
  icon: Icon,
  tone = "erp",
  compact = false,
  className,
  ...props
}: ModuleIdentityProps) {
  const moduleId = React.useId();
  const descriptionId = React.useId();

  return (
    <div
      role="group"
      aria-labelledby={moduleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn("min-w-0 rounded-lg border", compact ? "p-2.5" : "p-3", toneClasses[tone], className)}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="shrink-0 rounded-md bg-background/70 p-2 shadow-xs">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] opacity-70">{productName}</p>
          <p id={moduleId} className="truncate text-sm font-semibold text-foreground">
            {moduleName}
          </p>
          {companyName ? <p className="truncate text-xs text-muted-foreground">{companyName}</p> : null}
        </div>
      </div>
      {description ? (
        <p id={descriptionId} className="mt-2 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export type { ModuleIdentityProps, ModuleIdentityTone };
