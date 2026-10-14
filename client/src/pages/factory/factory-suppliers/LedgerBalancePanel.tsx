import type { FactorySupplierLedgerViewDto } from "./factorySupplierTypes";

interface LedgerBalancePanelProps {
  view: FactorySupplierLedgerViewDto;
  /** The operational container figure, shown only as a labelled memo. */
  operationalTotal?: string;
  formatNum: (val: string) => string;
  /** Same current-rate USD equivalent as the outside supplier card. */
  usdEquivalentBalance?: string | null;
  usdEquivalentMissingRates?: string[];
}

const amountText = (value: number, prefix: string, formatNum: (val: string) => string) =>
  `${prefix}${formatNum(Math.abs(value).toFixed(2))}${value < 0 ? " DR" : value > 0 ? " CR" : ""}`;

/**
 * Factory supplier balance on the ledger (accounting audit wave 13): the USD
 * ledger balance first, the native balance per currency beside it, then the
 * amounts not yet in the ledger and the operational figure as labelled memos.
 */
export function LedgerBalancePanel({
  view,
  formatNum,
  usdEquivalentBalance,
  usdEquivalentMissingRates = [],
}: LedgerBalancePanelProps) {
  const ledger = Number(view.ledgerBalanceUsd);
  const natives = view.nativeBalances.filter((bucket) => Math.abs(Number(bucket.balance)) > 0.005);
  return (
    <div className="rounded-xl border p-4 space-y-3" data-testid="panel-supplier-ledger-balance">
      {usdEquivalentBalance !== undefined && (
        <div>
          <div className="text-xs text-muted-foreground">Total balance (USD equivalent at Factory Settings rates)</div>
          {usdEquivalentBalance === null ? (
            <div className="text-sm text-amber-600" role="alert">
              FX rate missing: {usdEquivalentMissingRates.join(", ") || "please check Factory Settings"}
            </div>
          ) : (
            <div className="text-xl font-bold tabular-nums" data-testid="text-supplier-usd-equivalent">
              {amountText(Number(usdEquivalentBalance), "$", formatNum)}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">Posted ledger (historical USD)</div>
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
        <p className="text-xs text-amber-600" role="alert">
          USD total needs historical FX repair:{" "}
          {view.nativeBalances.reduce((count, bucket) => count + bucket.legacyUnconvertedLines, 0)} ledger lines have no
          validated USD conversion. Do not use this total as a settled balance.
        </p>
      )}
      {view.notInLedger.lines.length > 0 && (
        <div className="border-t pt-3 space-y-2" role="status">
          <p className="text-xs font-semibold text-amber-600">
            {view.notInLedger.lines.length} source amount(s) still missing from the ledger — not included in the posted
            balance.
          </p>
          <div className="text-xs space-y-1">
            {view.notInLedger.lines.map((line) => (
              <div key={`${line.source}-${line.sourceId}`} className="flex flex-wrap justify-between gap-2">
                <span>
                  {line.sourceLabel} · {line.reference ?? line.sourceId}
                </span>
                <span>
                  {line.currency} {formatNum(line.nativeAmount.replace("-", ""))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
