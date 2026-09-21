import { memo } from "react";
import { StatCard, type StatCardProps } from "@/components/StatCard";

export interface FactoryKpiCardProps extends Omit<StatCardProps, "tone"> {
  /** Production-flavored tone preset. */
  metric?: "input" | "output" | "yield" | "downtime" | "scrap" | "neutral";
}

const METRIC_TONE: Record<NonNullable<FactoryKpiCardProps["metric"]>, StatCardProps["tone"]> = {
  input: "info",
  output: "chart-2",
  yield: "success",
  downtime: "warning",
  scrap: "destructive",
  neutral: "primary",
};

/**
 * FactoryKpiCard — Factory-themed StatCard. Maps factory metrics (input,
 * output, yield, downtime, scrap) to consistent tones so all factory
 * dashboards (FactoryDashboard, ContainerDashboard production tab,
 * production-cycles, batch detail) share one visual grammar.
 */
function FactoryKpiCardComponent({ metric = "neutral", ...rest }: FactoryKpiCardProps) {
  return <StatCard tone={METRIC_TONE[metric]} {...rest} />;
}

export const FactoryKpiCard = memo(FactoryKpiCardComponent);
