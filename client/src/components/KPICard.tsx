import { memo } from "react";
import { StatCard, type StatCardProps } from "@/components/StatCard";
import type { LucideIcon } from "lucide-react";

interface KPICardProps {
  title: string;
  value: string;
  change?: string;
  changeType?: "positive" | "negative" | "neutral";
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  "data-testid"?: string;
}

/**
 * KPICard — back-compat alias kept so existing dashboards continue to compile.
 * Delegates to the canonical {@link StatCard} primitive so every dashboard
 * automatically shares the same KPI grammar (title + value + delta + icon
 * + tone + skeleton state).
 */
function KPICardComponent(props: KPICardProps) {
  const { title, value, change, changeType, icon, onClick, "data-testid": testId } = props;
  const statProps: StatCardProps = {
    title,
    value,
    change,
    changeType,
    icon,
    tone: "primary",
    onClick,
    "data-testid": testId,
  };
  return <StatCard {...statProps} />;
}

export const KPICard = memo(KPICardComponent);
