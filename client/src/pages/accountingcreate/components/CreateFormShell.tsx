import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

interface CreateFormShellProps {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}

export function CreateFormShell({ icon: Icon, title, description, children }: CreateFormShellProps) {
  return (
    <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-4 border-b border-border/70 bg-muted/30 px-5 py-5 md:px-7">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="p-5 md:p-7 [&_input]:min-h-11 [&_input]:rounded-lg [&_[role=combobox]]:min-h-11 [&_[role=combobox]]:rounded-lg">
        {children}
      </div>
    </Card>
  );
}
