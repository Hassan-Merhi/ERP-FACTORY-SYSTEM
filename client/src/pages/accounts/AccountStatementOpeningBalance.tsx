/**
 * The brought-forward balance shown in the account statement summaries (desktop
 * KPI strip and phone summary grid). One component keeps both in step, and lets
 * tests render it instead of reading AccountStatementView's source.
 */
import { Landmark } from "lucide-react";

export function openingBalanceLabel(showNativeBalance: boolean): string {
  return showNativeBalance ? "Historical USD opening" : "Opening Balance";
}

export function OpeningBalanceAmount({
  openingBalance,
  side,
  formatAmount,
  sideClassName = "ms-1 text-[11px] font-normal opacity-70",
}: {
  openingBalance: number;
  side: string;
  formatAmount: (amount: number) => string;
  sideClassName?: string;
}) {
  return (
    <>
      {formatAmount(Math.abs(openingBalance))}
      <span className={sideClassName}>{side}</span>
    </>
  );
}

/** Desktop KPI card for the opening balance. */
export function AccountStatementOpeningBalanceKpi({
  showNativeBalance,
  openingBalance,
  side,
  formatAmount,
}: {
  showNativeBalance: boolean;
  openingBalance: number;
  side: string;
  formatAmount: (amount: number) => string;
}) {
  return (
    <div className="account-ledger-stat" data-testid="account-statement-kpi-opening-balance">
      <Landmark className="w-4 h-4 text-muted-foreground shrink-0" />
      <div>
        <p className="text-[11px] text-muted-foreground leading-none mb-0.5">
          {openingBalanceLabel(showNativeBalance)}
        </p>
        <p className="text-base font-semibold leading-none tabular-nums">
          <OpeningBalanceAmount
            openingBalance={openingBalance}
            side={side}
            formatAmount={formatAmount}
            sideClassName="ml-1 text-[11px] font-normal opacity-70"
          />
        </p>
      </div>
    </div>
  );
}
