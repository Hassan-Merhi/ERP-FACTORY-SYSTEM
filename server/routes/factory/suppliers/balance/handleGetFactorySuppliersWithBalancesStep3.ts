// Extracted from ./with-balances.ts to keep that module under the source-size cap.
import { buildBrokerStatement } from "./_helpers";
import { handleGetFactorySuppliersWithBalancesStep1 } from "./handleGetFactorySuppliersWithBalancesStep1";
import { handleGetFactorySuppliersWithBalancesStep2 } from "./handleGetFactorySuppliersWithBalancesStep2";

export async function handleGetFactorySuppliersWithBalancesStep3({
  companyId,
  computeStats,
  includeOtw,
  suppliersList,
}: Pick<
  Extract<Awaited<ReturnType<typeof handleGetFactorySuppliersWithBalancesStep1>>, { done: false }> &
    Awaited<ReturnType<typeof handleGetFactorySuppliersWithBalancesStep2>>,
  "companyId" | "computeStats" | "includeOtw" | "suppliersList"
>) {
  // First pass: compute each supplier's own stats
  const statsById: Record<number, ReturnType<typeof computeStats>> = {};
  for (const s of suppliersList) {
    statsById[s.id] = computeStats(s, includeOtw);
  }

  // Pre-compute broker statements for each broker parent so the list card
  // balance matches the detail page exactly (same data source).
  const brokerParentIds = new Set<number>(
    suppliersList.filter((s) => s.isBroker || suppliersList.some((c) => c.parentId === s.id)).map((s) => s.id)
  );
  const brokerStmtMap: Record<number, NonNullable<Awaited<ReturnType<typeof buildBrokerStatement>>>> = {};
  // Independent per-broker reads: run them together, not one after another.
  await Promise.all(
    [...brokerParentIds].map(async (brokerId) => {
      const stmt = await buildBrokerStatement(brokerId, companyId, includeOtw);
      if (stmt) brokerStmtMap[brokerId] = stmt;
    })
  );
  return { brokerParentIds, brokerStmtMap, statsById };
}
