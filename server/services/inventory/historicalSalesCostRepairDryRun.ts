/** Per-company dry run of the historical sales-cost repair: loads evidence and runs each proof phase. */
import type { PoolClient } from "pg";

import { historicalInventoryKey } from "./historicalSalesCostRepairEngine";
import { CompanyDryRun, distinctBlockedItemLocations } from "./historicalSalesCostRepairTypes";
import { rateHullBlocks } from "./historicalSalesCostRepairRecovery";
import { dryRunCompanyStep1 } from "./historicalSalesCostRepairDryRunDryRunCompanyStep1";
import { dryRunCompanyStep2 } from "./historicalSalesCostRepairDryRunDryRunCompanyStep2";

export async function dryRunCompany(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date,
  options: { diagnoseKeys?: Set<string> } = {}
): Promise<CompanyDryRun> {
  const {
    canonical,
    canonicalForReplay,
    canonicalStart,
    checkpoint,
    checks,
    closedEraProvenSaleIds,
    directCanonicalProposals,
    evidencedOpeningStates,
    historicalMerges,
    inventoryResult,
    legacy,
    legacyMovements,
    legacySales,
    legacyTransferFallbackMovements,
    manual,
    normalizedCanonicalPosReplay,
    offloadEvidence,
    proposalsBySaleId,
    rewindTrace,
    sales,
    sourceEvidenceHash,
    stockItems,
    targetKeys,
    traceRewind,
    valuationResetMovements,
  } = await dryRunCompanyStep1(client, companyId, sourceCutoff, options);
  dryRunCompanyStep2(
    {
      canonicalForReplay,
      checkpoint,
      checks,
      closedEraProvenSaleIds,
      evidencedOpeningStates,
      historicalMerges,
      inventoryResult,
      legacyMovements,
      legacySales,
      legacyTransferFallbackMovements,
      normalizedCanonicalPosReplay,
      proposalsBySaleId,
      stockItems,
      targetKeys,
      traceRewind,
    },
    companyId
  );
  const { proposals, report } = dryRunCompanyStep3(
    {
      canonical,
      canonicalStart,
      checkpoint,
      checks,
      closedEraProvenSaleIds,
      directCanonicalProposals,
      historicalMerges,
      inventoryResult,
      legacy,
      legacySales,
      manual,
      offloadEvidence,
      proposalsBySaleId,
      rewindTrace,
      sales,
      sourceEvidenceHash,
      stockItems,
      valuationResetMovements,
    },
    companyId,
    sourceCutoff,
    options
  );

  return { proposals, checks, report };
}

function dryRunCompanyStep3(
  {
    canonical,
    canonicalStart,
    checkpoint,
    checks,
    closedEraProvenSaleIds,
    directCanonicalProposals,
    historicalMerges,
    inventoryResult,
    legacy,
    legacySales,
    manual,
    offloadEvidence,
    proposalsBySaleId,
    rewindTrace,
    sales,
    sourceEvidenceHash,
    stockItems,
    valuationResetMovements,
  }: Pick<
    Awaited<ReturnType<typeof dryRunCompanyStep1>>,
    | "canonical"
    | "canonicalStart"
    | "checkpoint"
    | "checks"
    | "closedEraProvenSaleIds"
    | "directCanonicalProposals"
    | "historicalMerges"
    | "inventoryResult"
    | "legacy"
    | "legacySales"
    | "manual"
    | "offloadEvidence"
    | "proposalsBySaleId"
    | "rewindTrace"
    | "sales"
    | "sourceEvidenceHash"
    | "stockItems"
    | "valuationResetMovements"
  >,
  companyId: number,
  sourceCutoff: Date,
  options: { diagnoseKeys?: Set<string> } = {}
) {
  // V32: a moving weighted average is a convex combination of the rates that
  // fed it, so a reconstructed sale cost can never leave the range of every
  // rate the item ever carried. Run #33 marked legacy proposals of 536M/unit
  // (item normally ~107) "ready": a rewind chain amplified a small inverse
  // error geometrically while every local step still looked consistent. Any
  // reconstructed proposal outside the evidenced range proves the chain for
  // that item/location is wrong, so every legacy proposal there is blocked.
  checks.push(
    ...rateHullBlocks({
      companyId,
      proposals: [...proposalsBySaleId.values()],
      stockItems,
      canonical,
      legacy,
      offloadEvidence,
      checkpoint,
      historicalMerges,
      independentSaleIds: closedEraProvenSaleIds,
    })
  );

  const diagnosedKeys = new Set(options.diagnoseKeys ?? []);
  for (const check of checks) {
    if (check.status === "block" && check.locationId !== null && check.stockItemId !== null) {
      diagnosedKeys.add(historicalInventoryKey(companyId, check.locationId, check.stockItemId));
    }
  }
  for (const key of [...diagnosedKeys].sort()) {
    const lines = rewindTrace.get(key);
    if (!lines?.length) continue;
    const [, locationIdText, stockItemIdText] = key.split(":");
    checks.push({
      companyId,
      locationId: Number(locationIdText),
      stockItemId: Number(stockItemIdText),
      code: "REWIND_TIMELINE_DIAGNOSTIC",
      status: "warning",
      expected: String(lines.length),
      detail: lines.join("\n"),
    });
  }

  const proposals = [...directCanonicalProposals.values(), ...proposalsBySaleId.values()].sort(
    (a, b) => a.salesItemId - b.salesItemId
  );
  const report = {
    companyId,
    canonicalStart: canonicalStart ? canonicalStart.toISOString() : null,
    sourceCutoff: sourceCutoff.toISOString(),
    checkpointAt: checkpoint?.createdAt.toISOString() ?? null,
    checkpointMovementCutoffId: checkpoint?.movementCutoffId ?? null,
    sourceEvidenceHash,
    activeInventoryRows: inventoryResult.rows.length,
    checkpointRows: checkpoint?.rows.length ?? 0,
    stockItems: stockItems.length,
    canonicalMovements: canonical.length,
    legacyMovements: legacy.length + manual.movements.length,
    saleRows: sales.length,
    canonicalSaleRows: directCanonicalProposals.size,
    legacySaleRows: legacySales.length,
    historicalMerges: historicalMerges.length,
    exactOffloadEvidenceRows: offloadEvidence.length,
    valuationResetEvidenceRows: valuationResetMovements.length,
    proposedRows: proposals.length,
    changedSaleRows: proposals.filter((proposal) => proposal.changed).length,
    blockedItemLocations: distinctBlockedItemLocations(checks),
  };
  return { proposals, report };
}
