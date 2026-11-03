import type { ReactNode } from "react";
import { ClipboardCheck, Target, Users, UserX } from "lucide-react";
import type { FactoryStaffTrackingTranslationKey } from "@/i18n/factoryStaffTrackingTranslations";
import { PremiumKpiCard } from "./PremiumKpiCard";

/**
 * The Production Targets dashboard KPI cards (approved redesign, #2659): target
 * with the absent target, workers present/absent, expected, produced, and the
 * produced-minus-expected difference.
 */
export function ProductionTargetKpiGrid({
  tr,
  totals,
  workerTotals,
  missingTargetDays,
}: {
  tr: (key: FactoryStaffTrackingTranslationKey) => string;
  totals: { target: number; absentTarget: number; expected: number; produced: number; difference: number };
  workerTotals: { total: number; present: number; absent: number };
  missingTargetDays: number;
}): ReactNode {
  return (
    <div className="pt-kpi-grid">
      <PremiumKpiCard
        tone="violet"
        label={tr("totalTarget")}
        value={totals.target}
        icon={<Target className="h-6 w-6" />}
        subline={
          <span>
            {tr("absent")}: {totals.absentTarget}
          </span>
        }
      />
      <PremiumKpiCard
        tone="green"
        label={tr("totalWorkers")}
        value={workerTotals.total}
        icon={<Users className="h-6 w-6" />}
        subline={
          <>
            <span>
              {tr("present")}: {workerTotals.present}
            </span>
            <span>·</span>
            <span>
              {tr("absent")}: {workerTotals.absent}
            </span>
          </>
        }
      />
      <PremiumKpiCard
        tone="blue"
        label={tr("totalExpected")}
        value={totals.expected}
        icon={<ClipboardCheck className="h-6 w-6" />}
        subline={<span>{tr("expected")}</span>}
      />
      <PremiumKpiCard
        tone="amber"
        label={tr("totalProduced")}
        value={totals.produced}
        icon={<ClipboardCheck className="h-6 w-6" />}
        subline={<span>{tr("produced")}</span>}
      />
      <PremiumKpiCard
        tone={missingTargetDays > 0 ? "amber" : totals.difference < 0 ? "red" : "green"}
        label={tr("diff")}
        value={missingTargetDays > 0 ? "—" : totals.difference > 0 ? `+${totals.difference}` : totals.difference}
        icon={<UserX className="h-6 w-6" />}
        subline={
          <span>{missingTargetDays > 0 ? "Missing targets in selected period" : "Produced versus expected"}</span>
        }
      />
    </div>
  );
}
