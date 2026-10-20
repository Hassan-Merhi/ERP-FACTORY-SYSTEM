import type { FxAgentAccountBalance } from "./accountTypes";

const fmt = (amount: string) =>
  Number(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Display-only denomination projection for a Factory FX ledger.
 * Source voucher entries stay in historical USD; native EUR comes from the
 * immutable wallet movements and is never inferred from the GL closing total.
 */
export function FxAgentNativeBalance({
  wallet,
  compact = false,
}: {
  wallet: FxAgentAccountBalance;
  compact?: boolean;
}) {
  if (!wallet.synchronized) {
    return compact ? (
      <div className="text-xs text-destructive" data-testid="fx-agent-ledger-drift">
        FX wallet needs reconciliation — USD ledger {fmt(wallet.ledgerBookUsd)}
      </div>
    ) : (
      <section className="rounded-lg border border-destructive/50 p-3 text-sm" data-testid="fx-agent-ledger-drift">
        <p className="font-medium text-destructive">FX wallet and USD ledger do not match</p>
        <p className="text-muted-foreground">
          Native EUR {fmt(wallet.state.eur)} · USD {fmt(wallet.state.usd)}.
          Historical USD book {fmt(wallet.state.totalBookUsd)}; posted USD ledger {fmt(wallet.ledgerBookUsd)}.
          Review the difference in Edit Account → FX Agent before using this balance.
        </p>
      </section>
    );
  }

  if (compact) {
    return (
      <div className="flex flex-col items-end gap-0.5 font-mono tabular-nums" data-testid="fx-agent-native-compact">
        <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
          EUR {fmt(wallet.state.eur)}
        </span>
        <span className="text-[11px] text-muted-foreground">
          USD {fmt(wallet.state.usd)} · Historic USD {fmt(wallet.ledgerBookUsd)}
        </span>
      </div>
    );
  }

  return (
    <section className="rounded-lg border bg-muted/20 px-4 py-3 space-y-2" data-testid="fx-agent-native-statement">
      <h4 className="text-sm font-semibold">FX agent — current native balances</h4>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">EUR held by agent</p>
          <p className="font-mono font-semibold tabular-nums">EUR {fmt(wallet.state.eur)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">USD held by agent</p>
          <p className="font-mono font-semibold tabular-nums">USD {fmt(wallet.state.usd)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Historical USD book (ledger)</p>
          <p className="font-mono font-semibold tabular-nums">USD {fmt(wallet.ledgerBookUsd)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Net Position USD at Settings rate</p>
          <p className="font-mono font-semibold tabular-nums">
            {wallet.currentUsd === null ? "Rate unavailable" : "USD " + fmt(wallet.currentUsd)}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        EUR is the agent's actual currency balance. The journal rows, debit/credit totals,
        running balances, PDF and Excel statements remain in historical USD for audit;
        they are not additional USD available to spend.
      </p>
    </section>
  );
}
