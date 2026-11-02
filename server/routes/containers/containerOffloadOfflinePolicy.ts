import { randomUUID } from "node:crypto";
import type { DbTransaction } from "../../db";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import { capturePhase9ReceivingTx, phase9ReceivingLineDigestTx } from "../../edge/phase9ReceivingOutbox";
import { toMoney } from "../../lib/money";
import type { ContainerOffloadLifecycleResult } from "../../services/containers/offload-lifecycle";

interface OffloadCharges {
  duties?: unknown;
  officeCharges?: unknown;
  transferCharges?: unknown;
  transportFees?: unknown;
  additionalCharges?: unknown[];
  inventoryCostCorrections?: unknown[];
  agentChargeLines?: unknown[];
}

const zero = (value: unknown) => value == null || value === "" || toMoney(String(value)).isZero();

/**
 * Owner-approved offline receiving (2026-11-01) on the factory LAN server:
 * a first offload against the container's existing purchase orders,
 * quantities only — no duties, charges, cost corrections or agent lines.
 * Returns a refusal code, or null when it may be recorded offline.
 */
export function offlineReceivingRefusal(data: OffloadCharges): string | null {
  if (
    !zero(data.duties) ||
    !zero(data.officeCharges) ||
    !zero(data.transferCharges) ||
    !zero(data.transportFees) ||
    (data.additionalCharges?.length ?? 0) > 0 ||
    (data.inventoryCostCorrections?.length ?? 0) > 0 ||
    (data.agentChargeLines?.length ?? 0) > 0
  ) {
    return "EDGE_RECEIVING_QUANTITY_ONLY";
  }
  return null;
}

/**
 * On the LAN primary, the hook that records the committed receipt inside the
 * offload transaction; elsewhere undefined. Replacing an existing offload is
 * never an offline receipt and rolls the transaction back.
 */
export function offlineReceivingCapture(actor: {
  userId: string;
  username: string;
  offloadDate: string;
}): ((tx: DbTransaction, result: ContainerOffloadLifecycleResult) => Promise<void>) | undefined {
  if (!isPhase9LanPrimary()) return undefined;
  return async (tx, result) => {
    if (result.replacedExistingOffload) throw new Error("EDGE_RECEIVING_ALREADY_OFFLOADED");
    const offload = result.offload;
    await capturePhase9ReceivingTx(tx, {
      companyId: result.companyId,
      localOffloadId: Number(offload.id),
      containerId: Number(offload.containerId),
      locationId: result.locationId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      requestId: randomUUID(),
      offloadDate: actor.offloadDate,
      lineDigest: await phase9ReceivingLineDigestTx(tx, result.companyId, Number(offload.containerId)),
    });
  };
}
