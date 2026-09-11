/**
 * KpiCard — extracted sub-component.
 *
 * Extracted from FactoryFinancialSnapshot.tsx during the Phase 4 god-file split.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { LucideIcon } from "lucide-react";

export function KpiCard({
  icon: Icon,
  title,
  value,
  sub,
  color = "default",
  loading = false,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  sub?: string;
  color?: "default" | "green" | "amber" | "red" | "blue" | "purple";
  loading?: boolean;
}) {
  const iconColors: Record<string, string> = {
    default: "text-muted-foreground",
    green: "text-emerald-500",
    amber: "text-amber-500",
    red: "text-red-500",
    blue: "text-blue-500",
    purple: "text-purple-500",
  };
  const valueColors: Record<string, string> = {
    default: "text-foreground",
    green: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
    blue: "text-blue-600 dark:text-blue-400",
    purple: "text-purple-600 dark:text-purple-400",
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Skeleton className="h-9 w-9 rounded-md shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid={`kpi-card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 p-2 rounded-md bg-muted shrink-0 ${iconColors[color]}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground font-medium truncate">{title}</p>
            <p
              className={`text-lg font-semibold font-mono mt-0.5 ${valueColors[color]}`}
              data-testid={`value-${title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {value}
            </p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
