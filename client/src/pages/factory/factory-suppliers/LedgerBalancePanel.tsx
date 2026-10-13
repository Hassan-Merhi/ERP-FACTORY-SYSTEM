import type { FactorySupplierLedgerViewDto } from "./factorySupplierTypes";

interface LedgerBalancePanelProps {
  view: FactorySupplierLedgerViewDto;
  /** The operational container figure, shown only as a labelled memo. */
  operationalTotal?: string;
  formatNum: (val: string) => string;
}

const amountText = (value: number, prefix: string, formatNum: (val: string) => string) =>
  `${prefix}${formatNum(Math.abs(value).toFixed(2))}${value < 0 ? " CR" : ""}`;

/**
 * Factory supplier balance on the ledger (accounting audit wave 13): the USD
 * ledger balance first, the native balance per currency beside it, then the
 * amounts not yet in the ledger and the operational figure as labelled memos.
 */
export function LedgerBalancePanel({ view, operationalTotal, formatNum }: LedgerBalancePanelProps) {
  const ledger = Number(view.ledgerBalanceUsd);
  const notInLedger = Number(view.notInLedger.total);
  const operational = operationalTotal === undefined ? null : Number(operationalTotal);
  const natives = view.nativeBalances.filter((bucket) => Math.abs(Number(bucket.balance)) > 0.005);
  return (
    <div className="rounded-xl border p-4 space-y-3" data-testid="panel-supplier-ledger-balance">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">Ledger balance (USD)</div>
          <div className="text-xl font-bold" data-testid="text-supplier-ledger-balance">
            {amountText(ledger, "$", formatNum)}
          </div>
        </div>
        {natives.length > 0 && (
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Ledger balance by currency</div>
            {natives.map((bucket) => (
              <div key={bucket.currencyCode} className="text-sm tabular-nums">
                {amountText(Number(bucket.balance), `${bucket.currencyCode} `, formatNum)}
              </div>
            ))}
          </div>
        )}
      </div>
      {view.ledgerFxUnresolved && (
        <p className="text-xs text-amber-600">Some ledger lines hold a foreign amount without a USD conversion</p>
      )}
    </div>
  );
}
