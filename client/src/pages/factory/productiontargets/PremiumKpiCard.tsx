import type { ReactNode } from "react";

/** One Production Targets dashboard KPI card (approved redesign, #2659). */
export function PremiumKpiCard({
  label,
  value,
  icon,
  tone,
  subline,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
  tone: "violet" | "green" | "blue" | "amber" | "red";
  subline: ReactNode;
}) {
  return (
    <div className={`pt-kpi pt-kpi--${tone}`}>
      <div className="pt-kpi-top">
        <span className="pt-kpi-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="pt-kpi-label">{label}</div>
          <div className="pt-kpi-value" title={String(value)}>
            {value}
          </div>
        </div>
      </div>
      <div>
        <div className="pt-kpi-rule" aria-hidden="true" />
        <div className="pt-kpi-foot">{subline}</div>
      </div>
    </div>
  );
}
