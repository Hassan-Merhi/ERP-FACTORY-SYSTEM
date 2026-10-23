/**
 * Factory Net Position: count FX-agent wallet events that existed only AFTER
 * the requested company-local business-day cutoff.
 *
 * Purely diagnostic. These rows must NOT change historical wallet balances.
 * The caller checks fxAgentTablesExist() first so deployments without the
 * optional FX-agent extension can still render historical Net Position.
 */
import { sql } from "drizzle-orm";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import type { HistoryEvidenceGap } from "./netPositionHistoryCoverage";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { netPositionRecordedThrough } from "./netPositionAsOf";

export type FxWalletHistoryCounts = {
  lateActivations: number | string | null;
  lateOperations: number | string | null;
};

export function summarizeFxWalletHistoryGaps(counts: FxWalletHistoryCounts): HistoryEvidenceGap[] {
  const parse = (raw: FxWalletHistoryCounts[keyof FxWalletHistoryCounts]): number => {
    if (raw === null || raw === undefined || raw === "") throw new Error("HISTORICAL_FX_WALLET_COVERAGE_INVALID");
    const amount = Number(raw);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("HISTORICAL_FX_WALLET_COVERAGE_INVALID");
    return amount;
  };
  const activations = parse(counts.lateActivations);
  const operations = parse(counts.lateOperations);
  const gaps: HistoryEvidenceGap[] = [];
  if (activations > 0) {
    gaps.push({
      code: "HISTORICAL_FX_WALLET_BACKDATED_ACTIVATION",
      category: "FX Agent Wallet / Ledger",
      severity: "review",
      records: activations,
      explanation:
        "Wallets were activated on or before this day but created later. They are excluded until actually recorded.",
    });
  }
  if (operations > 0) {
    gaps.push({
      code: "HISTORICAL_FX_WALLET_BACKDATED_OPERATION",
      category: "FX Agent Wallet / Ledger",
      severity: "review",
      records: operations,
      explanation:
        "Wallet movements have an earlier effective date but were entered later. They do not change this day's wallet or Net Position.",
    });
  }
  return gaps;
}

export async function loadFxWalletHistoryGaps(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<HistoryEvidenceGap[]> {
  if (!scope.isHistorical) return [];
  const cutoff = (column: ReturnType<typeof sql>) => netPositionRecordedThrough(column, scope, "timestamptz");
  const rows = resultRows<{ late_activations: string; late_operations: string }>(
    await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::text FROM factory_fx_agent_wallets w
         WHERE w.company_id = ${companyId}
           AND w.activated_on <= ${scope.asOf}::date
           AND NOT ${cutoff(sql`w.created_at`)}) AS late_activations,
        (SELECT COUNT(*)::text FROM factory_fx_agent_wallet_operations op
         WHERE op.company_id = ${companyId}
           AND op.effective_date <= ${scope.asOf}::date
           AND NOT ${cutoff(sql`op.created_at`)}) AS late_operations
    `)
  );
  if (!rows[0]) throw new Error("HISTORICAL_FX_WALLET_COVERAGE_EMPTY");
  return summarizeFxWalletHistoryGaps({
    lateActivations: rows[0].late_activations,
    lateOperations: rows[0].late_operations,
  });
}
