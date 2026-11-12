import { CheckCircle2, Clock3, ReceiptText, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

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
  return (
    <section
      className={cn("daybook-overview", hideAmounts && "daybook-overview--restricted")}
      aria-label="Daybook overview"
      data-testid="daybook-overview"
    >
      <div className="daybook-kpi daybook-kpi--count">
        <span className="daybook-kpi__icon">
          <ReceiptText className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="daybook-kpi__label">Matching vouchers</div>
          <div className="daybook-kpi__value" data-testid="daybook-kpi-count">
            {stats.vouchers.toLocaleString()}
          </div>
          <div className="daybook-kpi__caption">Selected period</div>
        </div>
      </div>
      {!hideAmounts && (
        <div className="daybook-kpi daybook-kpi--value">
          <span className="daybook-kpi__icon">
            <Wallet className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="daybook-kpi__label">Voucher value</div>
            <div className="daybook-kpi__value" data-testid="daybook-kpi-value">
              {formatAmount(stats.value)}
            </div>
            <div className="daybook-kpi__caption">{stats.scope} · not account balance</div>
          </div>
        </div>
      )}
      <div className="daybook-kpi daybook-kpi--active">
        <span className="daybook-kpi__icon">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="daybook-kpi__label">Active vouchers</div>
          <div className="daybook-kpi__value" data-testid="daybook-kpi-active">
            {stats.active.toLocaleString()}
          </div>
          <div className="daybook-kpi__caption">{stats.scope}</div>
        </div>
      </div>
      <div className="daybook-kpi daybook-kpi--optional">
        <span className="daybook-kpi__icon">
          <Clock3 className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="daybook-kpi__label">Optional vouchers</div>
          <div className="daybook-kpi__value" data-testid="daybook-kpi-optional">
            {stats.optional.toLocaleString()}
          </div>
          <div className="daybook-kpi__caption">{stats.scope}</div>
        </div>
      </div>
    </section>
  );
}
