import { useQuery } from "@tanstack/react-query";

interface FinancialImpact {
  rawMaterialDifference: number;
  currentBalanceOnTableAsset?: number;
  projectedBalanceOnTableAsset?: number;
  balanceOnTableDifference?: number;
  otherLedgerEffect: number;
  otherNetPositionEffect?: number;
  totalNetPositionEffect?: number;
  currentNetPosition: number | null;
  projectedNetPosition: number | null;
}

interface Preview {
  financialImpact?: FinancialImpact;
}

const QUERY_KEY = ["/api/factory/raw-stock/recalc/historical-replay"] as const;

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function HistoricalReplayNetEffectPanel() {
  const { data } = useQuery<Preview>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const response = await fetch(QUERY_KEY[0], { credentials: "same-origin" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Failed to load replay impact");
      return payload;
    },
    retry: false,
  });

  const impact = data?.financialImpact;
  if (!impact || impact.balanceOnTableDifference == null) return null;

  const totalEffect =
    impact.totalNetPositionEffect ?? impact.rawMaterialDifference + (impact.otherNetPositionEffect ?? 0);

  return (
    <div className="mb-5 rounded-xl border bg-card p-4 shadow-xs">
      <div className="mb-3">
        <div className="font-semibold">Why the projected Net Position changes</div>
        <p className="text-xs text-muted-foreground">
          The replay can change two non-ledger asset calculations. Supplier liabilities, vouchers, cash/bank and every
          accounting ledger remain unchanged.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Raw-material effect</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{money(impact.rawMaterialDifference)}</div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Balance on Table effect</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{money(impact.balanceOnTableDifference)}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {money(impact.currentBalanceOnTableAsset)} → {money(impact.projectedBalanceOnTableAsset)}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Total Net Position effect</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{money(totalEffect)}</div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Projected Net Position</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{money(impact.projectedNetPosition)}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Current: {money(impact.currentNetPosition)} · Ledger effect: {money(impact.otherLedgerEffect)}
          </div>
        </div>
      </div>
    </div>
  );
}
