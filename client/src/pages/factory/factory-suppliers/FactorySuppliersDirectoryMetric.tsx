// Extracted from ./FactorySuppliersDirectory.tsx to keep that module under the source-size cap.
import type { ReactNode } from "react";
import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";

export type SuppliersModel = ReturnType<typeof useFactorySuppliersModel>;

export function Metric({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  tone: "blue" | "emerald" | "violet";
}) {
  const styles = {
    blue: "border-blue-200 from-blue-50 to-white dark:border-blue-500/50 dark:from-[hsl(var(--factory-hue)_70%_21%)] dark:to-[hsl(var(--factory-hue)_75%_14%)]",
    emerald:
      "border-emerald-200 from-emerald-50 to-white dark:border-emerald-500/50 dark:from-[#0b3939] dark:to-[hsl(var(--factory-hue)_61%_11%)]",
    violet:
      "border-violet-200 from-violet-50 to-white dark:border-violet-500/50 dark:from-[hsl(var(--factory-hue)_43%_22%)] dark:to-[hsl(var(--factory-hue)_43%_18%)]",
  };
  const iconStyles = {
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
    emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
    violet: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  };
  return (
    <div
      className={"flex min-h-28 items-center gap-3 rounded-2xl border bg-gradient-to-br p-4 shadow-sm " + styles[tone]}
    >
      <div
        className={"flex h-11 w-11 shrink-0 items-center justify-center rounded-xl " + iconStyles[tone]}
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-slate-600 dark:text-slate-200">{label}</div>
        <div className="mt-1 text-2xl font-bold leading-none tabular-nums text-slate-900 dark:text-white">{value}</div>
      </div>
    </div>
  );
}
