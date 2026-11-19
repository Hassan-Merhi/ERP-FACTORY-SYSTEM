// Extracted from ./spGoldenCoastSetupRoutes.ts
import {
  goldenCoastPhase13IntercompanyDefinitions,
  summarizeGoldenCoastPhase13IntercompanyAccount,
} from "../../services/accounting/goldenCoastPhase13Intercompany";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import {
  loadIntercompanyCandidates,
  type DatabaseTransaction,
  type GoldenCoastCompanyPair,
} from "./spGoldenCoastSetupRoutesResolveCompanyPair";

export async function phase13StatusWithAuthorizedHadi(tx: DatabaseTransaction, pair: GoldenCoastCompanyPair) {
  const defs = goldenCoastPhase13IntercompanyDefinitions({
    goldenCoastCompanyName: pair.goldenCoastCompanyName,
    hadiCompanyName: pair.hadiCompanyName,
  });

  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  const goldenCoastRows = await loadIntercompanyCandidates(tx, pair.goldenCoastCompanyId, defs.golden_coast_hadi);
  const goldenCoastAccount = summarizeGoldenCoastPhase13IntercompanyAccount({
    companyId: pair.goldenCoastCompanyId,
    definition: defs.golden_coast_hadi,
    accounts: goldenCoastRows,
  });

  await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
  const hadiRows = await loadIntercompanyCandidates(tx, pair.hadiCompanyId, defs.hadi_golden_coast);
  const hadiAccount = summarizeGoldenCoastPhase13IntercompanyAccount({
    companyId: pair.hadiCompanyId,
    definition: defs.hadi_golden_coast,
    accounts: hadiRows,
  });
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  const blockers = [goldenCoastAccount, hadiAccount]
    .filter((item) => item.status !== "ok")
    .flatMap((item) => item.issues.map((issue) => `${item.role}: ${issue}`));
  return {
    isConfigured: blockers.length === 0,
    parentCompanyId: pair.hadiCompanyId,
    parentCompanyName: pair.hadiCompanyName,
    parentAuthorized: true,
    goldenCoastAccount,
    hadiAccount,
    blockers,
  };
}
