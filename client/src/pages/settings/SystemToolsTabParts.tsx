// Extracted from ./SystemToolsTab.tsx
import { ArrowUpRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Company } from "@shared/schema";

export interface SystemToolsTabProps {
  appMode: string;
  currentUser?: { role?: string };
  selectedCompany?: { id: number; name: string } | null;
  companies: Company[];
}

export interface ToolCard {
  category: string;
  categoryColor: string;
  icon: ReactNode;
  iconBg: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  testId?: string;
  devOnly?: boolean;
}

export function SectionHeading({
  icon: Icon,
  eyebrow,
  title,
  description,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
        <h3 className="mt-1 text-sm font-semibold tracking-tight">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function SystemToolCard({ card }: { card: ToolCard }) {
  return (
    <div
      className="group flex min-h-[218px] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/80 p-5 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md sm:p-6"
      data-testid={card.testId}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${card.iconBg}`}>{card.icon}</div>
        <Badge className={`rounded-full border-0 px-2.5 py-1 text-[11px] font-semibold ${card.categoryColor}`}>
          {card.category}
        </Badge>
      </div>

      <div className="mt-5 flex-1 space-y-1.5">
        <h4 className="text-base font-semibold tracking-tight">{card.title}</h4>
        <p className="max-w-sm text-sm leading-5 text-muted-foreground">{card.description}</p>
      </div>

      <Button
        variant="outline"
        className="mt-5 h-10 w-full justify-between border-border/70 bg-background/50 transition-colors group-hover:border-primary/30 group-hover:bg-primary/3"
        onClick={card.onAction}
        data-testid={`button-action-${card.testId}`}
      >
        <span>{card.actionLabel}</span>
        <ArrowUpRight className="h-4 w-4 text-primary transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </Button>
    </div>
  );
}
