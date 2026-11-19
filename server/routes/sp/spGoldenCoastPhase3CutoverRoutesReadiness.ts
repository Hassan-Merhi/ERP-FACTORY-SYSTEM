// Extracted from ./spGoldenCoastPhase3CutoverRoutes.ts
import { db } from "../../db";
import {
  summarizeGoldenCoastAccountSetup,
  type GoldenCoastAccountRole,
} from "../../services/accounting/goldenCoastPhase2Accounts";
import {
  GOLDEN_COAST_PHASE3_CUTOVER_DATE,
  goldenCoastPhase3VoucherNumber,
} from "../../services/accounting/goldenCoastPhase3Cutover";
import { loadGoldenCoastAccounts, loadGoldenCoastSettings } from "./spGoldenCoastSetupRoutes";
import {
  canonicalPreCutoverBalances,
  existingCutoverVoucherTx,
  existingPositionCarryForwardVoucherTx,
  resolveRoleAccounts,
  type DatabaseTransaction,
} from "./canonicalPreCutoverBalances";

export async function readiness(tx: DatabaseTransaction | typeof db, companyId: number) {
  const [accounts, settings, existingVoucher, existingPositionCarryForwardVoucher] = await Promise.all([
    loadGoldenCoastAccounts(tx, companyId),
    loadGoldenCoastSettings(tx, companyId),
    existingCutoverVoucherTx(tx, companyId),
    existingPositionCarryForwardVoucherTx(tx, companyId),
  ]);
  const phase2 = summarizeGoldenCoastAccountSetup({ companyId, accounts, settings });
  const blockers: string[] = [];
  let preCutoverBalances: Array<{
    role: GoldenCoastAccountRole;
    accountId: number;
    debitMinusCreditUsd: string;
  }> = [];

  if (!phase2.isConfigured) {
    blockers.push("Golden Coast Phase 2 account setup is not fully configured.");
  } else {
    try {
      resolveRoleAccounts(accounts);
      if (!existingVoucher && !existingPositionCarryForwardVoucher) {
        preCutoverBalances = await canonicalPreCutoverBalances(tx, companyId, accounts);
        const nonZero = preCutoverBalances.filter((item) => Math.abs(Number(item.debitMinusCreditUsd)) > 0.005);
        if (nonZero.length > 0) {
          blockers.push(
            `Canonical cutover accounts already contain pre-${GOLDEN_COAST_PHASE3_CUTOVER_DATE} opening or ledger balances; ` +
              "Phase 3 refuses to layer a fresh opening journal on top of historical balances. Reconcile or migrate those balances first."
          );
        }
      }
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    cutoverDate: GOLDEN_COAST_PHASE3_CUTOVER_DATE,
    voucherNumber: goldenCoastPhase3VoucherNumber(companyId),
    phase2,
    fundingModel: {
      freshStartContributedInventory: "Excluded from Hassan funding usage",
      cashFundedInventory: "Consumes Hassan funding",
      hassanSavings: "Automatic residual of Hassan's $100,000 opening funding balance",
    },
    preCutoverBalances,
    existingVoucher,
    existingPositionCarryForwardVoucher,
    posted: !!existingVoucher || !!existingPositionCarryForwardVoucher,
    openingMode: existingPositionCarryForwardVoucher
      ? "existing-position-carry-forward"
      : existingVoucher
        ? "standard"
        : null,
    blockers,
    canPreview: phase2.isConfigured,
    canPost: phase2.isConfigured && blockers.length === 0 && !existingVoucher && !existingPositionCarryForwardVoucher,
  };
}
