// Extracted from ./AiValidationPage.tsx
import { type SummaryCardProps } from "./useAiValidationPageState";

export function SummaryCard({ label, value, variant = "default" }: SummaryCardProps) {
  const colors: Record<string, string> = {
    default: "text-foreground",
    good: "text-green-600 dark:text-green-400",
    bad: "text-destructive",
    warn: "text-amber-600 dark:text-amber-400",
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card p-4">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold ${colors[variant]}`}>{value}</span>
    </div>
  );
}
