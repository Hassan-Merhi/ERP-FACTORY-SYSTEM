import { randomUUID } from "node:crypto";
import type { DbTransaction } from "../../db";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import { capturePhase9ReceivingTx, phase9ReceivingLineDigestTx } from "../../edge/phase9ReceivingOutbox";
import type { Phase9ReceivingOffloadInputs } from "../../edge/phase9ReceivingEnvelope.mjs";
import { toMoney } from "../../lib/money";
import type {
  ContainerOffloadLifecycleInput,
  ContainerOffloadLifecycleResult,
} from "../../services/containers/offload-lifecycle";

/** Canonical decimal string ("12.5", "0") for the immutable evidence. */
const decimal = (value: unknown): string => toMoney(String(value ?? "0")).toFixed();
const ref = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;

/** The offload exactly as entered, in the evidence's canonical form. */
export function offlineReceivingInputs(input: ContainerOffloadLifecycleInput): Phase9ReceivingOffloadInputs {
  return {
    duties: decimal(input.duties),
    dutiesAccountId: ref(input.dutiesAccountId),
    officeCharges: decimal(input.officeCharges),
    officeChargesAccountId: ref(input.officeChargesAccountId),
    officeChargesCashAccountId: ref(input.officeChargesCashAccountId),
    transferCharges: decimal(input.transferCharges),
    transportFees: decimal(input.transportFees),
    transportAccountId: ref(input.transportAccountId),
    additionalCharges: (input.additionalCharges ?? []).map((line) => ({
      description: String(line.description),
      amount: decimal(line.amount),
      ledgerAccountId: Number(line.ledgerAccountId),
    })),
    inventoryCostCorrections: (input.inventoryCostCorrections ?? []).map((line) => ({
      stockItemId: Number(line.stockItemId),
      correctRate: decimal(line.correctRate),
    })),
    agentChargeLines: (input.agentChargeLines ?? []).map((line) => ({
      description: typeof line.description === "string" ? line.description : null,
      amountUsd: decimal(line.amountUsd),
      parentAgentAccountId: Number(line.parentAgentAccountId),
    })),
  };
}

/**
 * On the LAN primary, the hook that records the committed offload (a first
 * offload or an edit, with all its charges) inside the offload transaction;
 * elsewhere undefined. Owner policy (2026-11-02): offloads, edits, duties and
 * charges may all be recorded offline and are replayed in the cloud as entered.
 */
export function offlineReceivingCapture(
  actor: { userId: string; username: string },
  input: ContainerOffloadLifecycleInput
): ((tx: DbTransaction, result: ContainerOffloadLifecycleResult) => Promise<void>) | undefined {
  if (!isPhase9LanPrimary()) return undefined;
  return async (tx, result) => {
    const offload = result.offload;
    await capturePhase9ReceivingTx(tx, {
      companyId: result.companyId,
      localOffloadId: Number(offload.id),
      containerId: Number(offload.containerId),
      locationId: result.locationId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      requestId: randomUUID(),
      offloadDate: input.offloadDate,
      lineDigest: await phase9ReceivingLineDigestTx(tx, result.companyId, Number(offload.containerId)),
      mode: result.replacedExistingOffload ? "edit" : "create",
      offload: offlineReceivingInputs(input),
    });
  };
}
