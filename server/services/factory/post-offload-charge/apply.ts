import type { DbTransaction } from "../../../db";
import { and, eq } from "drizzle-orm";
import { factoryContainers } from "../../../../shared/schema";
import { getAuthoritativeSupplierRemainingKg } from "../rawStockLockedRate";
import { getSupplierRateForUpdate } from "./legacy-links";
import { computeRemainingFraction, loadCostInputs } from "./loaders";
import { PostOffloadMutationParams, PostOffloadMutationResult } from "./types";
import { applyPostOffloadChargeUndo } from "./applyUndo";
import { applyPostOffloadChargeEdit } from "./applyEdit";
import { applyPostOffloadChargeCreate } from "./applyCreate";
import { applyPostOffloadChargeLegacyRebuild } from "./applyLegacyRebuild";

export async function applyPostOffloadChargeMutation(
  tx: DbTransaction,
  params: PostOffloadMutationParams
): Promise<PostOffloadMutationResult> {
  const { action, companyId, containerId, txDate, userId } = params;

  // ── Load container (with FOR UPDATE lock) ──────────────────────────────────
  const [container] = await tx
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
    .for("update");
  if (!container) throw new Error("Container not found");

  const supplierId = container.supplierId as number | null;

  // ── Shared cost inputs ─────────────────────────────────────────────────────
  const { commissionRecord, otherChargeRows } = await loadCostInputs(tx, companyId, containerId);

  // ── Capture supplier rate before mutation ─────────────────────────────────
  let supplierLockedRateBefore: string | null = null;
  let supplierRemainingKg = 0;
  if (supplierId) {
    supplierLockedRateBefore = await getSupplierRateForUpdate(tx, companyId, supplierId);
    supplierRemainingKg = await getAuthoritativeSupplierRemainingKg(tx, companyId, supplierId);
  }

  // ── Remaining fraction ─────────────────────────────────────────────────────
  const { dReceivedKg, dRemainingKg, dFraction } = await computeRemainingFraction(tx, companyId, containerId);

  // ─────────────────────────────────────────────────────────────────────────
  // Action: LEGACY_REBUILD
  // Fix the supplier locked rate for a charge that was applied with the old
  // (pre-fix) formula. Does NOT change container/raw-stock costs or accounting.
  // ─────────────────────────────────────────────────────────────────────────
  if (action === "LEGACY_REBUILD") {
    return await applyPostOffloadChargeLegacyRebuild({
      params,
      tx,
      companyId,
      supplierId,
      dFraction,
      supplierRemainingKg,
      userId,
      container,
      supplierLockedRateBefore,
      dReceivedKg,
      dRemainingKg,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Action: CREATE
  // ─────────────────────────────────────────────────────────────────────────
  if (action === "CREATE") {
    return await applyPostOffloadChargeCreate({
      params,
      companyId,
      tx,
      containerId,
      container,
      commissionRecord,
      otherChargeRows,
      userId,
      dFraction,
      supplierRemainingKg,
      supplierLockedRateBefore,
      supplierId,
      txDate,
      dReceivedKg,
      dRemainingKg,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Action: EDIT
  // ─────────────────────────────────────────────────────────────────────────
  if (action === "EDIT") {
    return await applyPostOffloadChargeEdit({
      params,
      companyId,
      tx,
      containerId,
      container,
      commissionRecord,
      otherChargeRows,
      userId,
      dFraction,
      supplierRemainingKg,
      supplierLockedRateBefore,
      supplierId,
      txDate,
      dReceivedKg,
      dRemainingKg,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Action: UNDO
  // ─────────────────────────────────────────────────────────────────────────
  if (action === "UNDO") {
    return await applyPostOffloadChargeUndo({
      params,
      tx,
      companyId,
      container,
      supplierRemainingKg,
      dReceivedKg,
      dRemainingKg,
      dFraction,
      containerId,
      commissionRecord,
      otherChargeRows,
      userId,
      supplierLockedRateBefore,
      supplierId,
    });
  }

  throw new Error(`Unknown action: ${action}`);
}
