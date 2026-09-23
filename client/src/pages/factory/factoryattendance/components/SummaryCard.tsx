/**
 * SummaryCard — extracted sub-component.
 *
 * Extracted from FactoryAttendance.tsx during the Phase 4 god-file split.
 */
import { Card, CardContent } from "@/components/ui/card";

export function SummaryCard({
  icon,
  label,
  value,
  color,
  testId,
  modern = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  testId: string;
  modern?: boolean;
}) {
  if (!modern) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 pb-4 pt-4">
          <div className={`shrink-0 ${color}`}>{icon}</div>
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`text-2xl font-bold ${color}`} data-testid={testId}>
              {value}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="group overflow-hidden border-border/70 bg-card/80 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:bg-card">
      <CardContent className="flex min-h-[96px] items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
          <p className={`mt-1.5 text-2xl font-bold tabular-nums tracking-tight ${color}`} data-testid={testId}>
            {value}
          </p>
        </div>
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border/70 bg-muted/30 ${color}`}>
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
