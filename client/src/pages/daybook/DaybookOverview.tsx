import { CheckCircle2, Clock3, ReceiptText, Wallet } from "lucide-react";
import { DaybookKpiStrip, type DaybookKpi } from "@/components/daybook/DaybookFrame";

export interface DaybookOverviewStats {
  vouchers: number;
  value: number | string;
  active: number;
  optional: number;
  scope: string;
}

interface DaybookOverviewProps {
  stats: DaybookOverviewStats;
  hideAmounts: boolean;
  formatAmount: (value: number | string) => string;
}

export function DaybookOverview({ stats, hideAmounts, formatAmount }: DaybookOverviewProps) {
  const items: DaybookKpi[] = [
    {
      id: "count",
      label: "Matching vouchers",
      value: stats.vouchers.toLocaleString(),
      caption: "Selected period",
      icon: ReceiptText,
      tone: "count",
      testId: "daybook-kpi-count",
    },
    ...(hideAmounts
      ? []
      : [
          {
            id: "value",
            label: "Voucher value",
            value: formatAmount(stats.value),
            caption: <>{stats.scope} · not account balance</>,
            icon: Wallet,
            tone: "value" as const,
            testId: "daybook-kpi-value",
          },
        ]),
    {
      id: "active",
      label: "Active vouchers",
      value: stats.active.toLocaleString(),
      caption: stats.scope,
      icon: CheckCircle2,
      tone: "active",
      testId: "daybook-kpi-active",
    },
    {
      id: "optional",
      label: "Optional vouchers",
      value: stats.optional.toLocaleString(),
      caption: stats.scope,
      icon: Clock3,
      tone: "optional",
      testId: "daybook-kpi-optional",
    },
  ];
  return <DaybookKpiStrip items={items} />;
}
