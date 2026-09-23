/**
 * SummaryCard — extracted sub-component.
 *
 * Extracted from FactoryAttendance.tsx during the Phase 4 god-file split.
 */
import {Card, CardContent} from "@/components/ui/card";

export function SummaryCard({
  icon,
  label,
  value,
  color,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  testId: string;
}) {
  return (
    <Card className="group overflow-hidden border-border/70 bg-card/80 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:bg-card">
      <CardContent className="flex min-h-[96px] items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
          <p className={`mt-1.5 text-2xl font-bold tabular-nums tracking-tight ${color}`} data-testid={testId}>
            {value}
          </p>
        </div>
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border/70 bg-muted/35 ${color}`}>
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
