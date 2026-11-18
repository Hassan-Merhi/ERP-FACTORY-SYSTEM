// Extracted from ./ProformaProgressPanel.tsx
import { CheckCircle, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ProformaLineStatus } from "@/lib/proformaCapacity";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";

export const STATUS_ORDER: Record<ProformaLineStatus, number> = {
  overloaded: 0,
  short: 1,
  none: 2,
  fulfilled: 3,
  reference: 4,
};

export const BADGE_BASE = "rounded-md text-[11px] no-default-hover-elevate no-default-active-elevate";

export function StatusBadge({
  status,
  model,
}: {
  status: ProformaLineStatus;
  model: FactoryContainerLoadingScanModel;
}) {
  if (status === "fulfilled") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300`}
      >
        <CheckCircle className="mr-1 h-3 w-3" />
        {model.tr("loaded")}
      </Badge>
    );
  }

  if (status === "overloaded") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300`}
      >
        {model.tr("overloaded")}
      </Badge>
    );
  }

  if (status === "short") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300`}
      >
        {model.tr("lessLoaded")}
      </Badge>
    );
  }

  if (status === "none") {
    return (
      <Badge
        variant="outline"
        className={`${BADGE_BASE} border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300`}
      >
        {model.tr("missing")}
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={`${BADGE_BASE} text-muted-foreground`}>
      <Info className="mr-1 h-3 w-3" />
      {model.tr("onProforma")}
    </Badge>
  );
}
