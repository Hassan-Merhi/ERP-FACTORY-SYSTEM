// Extracted from ./DataToolsView.tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { useDataToolsModel } from "./useDataToolsModel";

export type Props = {
  model: ReturnType<typeof useDataToolsModel>;
};

export function SectionHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function ToolCard({
  icon: Icon,
  title,
  description,
  children,
  action,
  accent = "primary",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
  action?: ReactNode;
  accent?: "primary" | "amber" | "blue";
}) {
  const iconStyles = {
    primary: "bg-primary/10 text-primary",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  };

  return (
    <Card className="group flex h-full flex-col overflow-hidden border-border/70 bg-card/80 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <CardHeader className="space-y-3 pb-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 ${iconStyles[accent]}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <CardTitle className="text-base tracking-tight">{title}</CardTitle>
          <CardDescription className="text-sm leading-5">{description}</CardDescription>
        </div>
      </CardHeader>
      {(children || action) && (
        <CardContent className="mt-auto space-y-4 pt-1">
          {children}
          {action}
        </CardContent>
      )}
    </Card>
  );
}
