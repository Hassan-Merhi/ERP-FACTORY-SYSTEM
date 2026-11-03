import { LockKeyhole } from "lucide-react";
import type { FactoryStaffTrackingTranslationKey } from "@/i18n/factoryStaffTrackingTranslations";

/** The Production Targets status notices: missing period targets and a finalized (locked) day. */
export function ProductionTargetNotices({
  tr,
  showMissingTargets,
  missingTargetDays,
  finalized,
}: {
  tr: (key: FactoryStaffTrackingTranslationKey) => string;
  showMissingTargets: boolean;
  missingTargetDays: number;
  finalized: boolean;
}) {
  return (
    <>
      {showMissingTargets && (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          role="status"
        >
          {missingTargetDays} worker-day targets are not configured in this range. The target and expected totals
          include only recorded daily targets; differences are withheld until the missing targets are set.
        </div>
      )}

      {finalized && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <div className="text-sm font-semibold">{tr("productionLocked")}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{tr("productionLockedDetail")}</div>
          </div>
        </div>
      )}
    </>
  );
}
