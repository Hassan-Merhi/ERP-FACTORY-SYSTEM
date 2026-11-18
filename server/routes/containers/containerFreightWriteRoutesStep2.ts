// Extracted from ./containerFreightWriteRoutes.ts: a stage of containerFreightWriteRoutes.
import { HttpError } from "../../lib/httpHandlers";
import { containers, containerOffloads, purchaseOrders, vouchers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { differsByMoreThanTolerance as differs } from "./containerHelpers";
import { toMoney } from "../../lib/money";
import type Decimal from "decimal.js";
import { assertOffloadedPurchaseOrderChargesUnchanged } from "./offloadedPurchaseOrderCostBasisGuard";
import type { containerFreightWriteRoutesStep } from "./containerFreightWriteRoutesStep";
import type { Request } from "express";
import type { DbTransaction } from "../../db";

type ContainerFreightWriteRoutesStepResult = Awaited<ReturnType<typeof containerFreightWriteRoutesStep>>;

export async function containerFreightWriteRoutesStep2({
  cfw1,
  tx,
  req,
  linkedParentCompanyId,
}: {
  cfw1: Extract<ContainerFreightWriteRoutesStepResult, { done: false }>;
  tx: DbTransaction;
  req: Request;
  linkedParentCompanyId: number | null;
}) {
  const {
    existingPO,
    id,
    newFreight,
    newSurcharge,
    newFumigation,
    newDocumentCharges,
    newDiscount,
    newOtherCharges,
    newItemsTotal,
    allowedUpdates,
    newLocalVoucherTotal,
  } = cfw1;
  // Serialize with other edits and the offload lifecycle on this PO, in the
  // offload lifecycle's lock order: container, then purchase order.
  let lockedContainer: { id: number; status: string | null } | undefined;
  if (existingPO.containerId != null) {
    [lockedContainer] = await tx
      .select({ id: containers.id, status: containers.status })
      .from(containers)
      .where(and(eq(containers.id, existingPO.containerId), eq(containers.companyId, existingPO.companyId)))
      .limit(1)
      .for("update");
    if (!lockedContainer) throw new HttpError(404, "Container not found");
  }
  const [lockedPO] = await tx
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, existingPO.companyId)))
    .limit(1)
    .for("update");
  if (!lockedPO) throw new HttpError(404, "Purchase order not found");

  const hasActiveOffload = lockedContainer
    ? (
        await tx
          .select({ id: containerOffloads.id })
          .from(containerOffloads)
          .where(and(eq(containerOffloads.containerId, lockedContainer.id), eq(containerOffloads.optional, false)))
          .limit(1)
      ).length > 0
    : false;
  if (lockedContainer?.status === "OFFLOADED" || hasActiveOffload) {
    if (String(req.body.currency ?? lockedPO.currency).toUpperCase() !== String(lockedPO.currency).toUpperCase()) {
      throw new HttpError(409, "Cannot change purchase currency after stock has been received.");
    }
    assertOffloadedPurchaseOrderChargesUnchanged(lockedPO, {
      freight: newFreight.toFixed(2),
      surcharge: newSurcharge.toFixed(2),
      fumigation: newFumigation.toFixed(2),
      documentCharges: newDocumentCharges.toFixed(2),
      discount: newDiscount.toFixed(2),
      otherCharges: newOtherCharges.toFixed(2),
    });
    if (!toMoney(lockedPO.itemsTotal).toDecimalPlaces(2).equals(newItemsTotal.toDecimalPlaces(2))) {
      throw new HttpError(
        409,
        "This container is offloaded. Its purchase item total is locked to its posted inventory receipt."
      );
    }
  }

  // Update PO
  const [updated] =
    Object.keys(allowedUpdates).length > 0
      ? await tx.update(purchaseOrders).set(allowedUpdates).where(eq(purchaseOrders.id, id)).returning()
      : await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);

  // Fetch actual current voucher total from DB so we catch vouchers that were
  // created before the freight-embedding fix (their stored total is wrong even
  // though the PO fields haven't "changed").
  let actualDbVoucherTotal: Decimal | null = null;
  if (existingPO.voucherId) {
    const [currentVoucher] = await tx
      .select({ totalAmount: vouchers.totalAmount })
      .from(vouchers)
      .where(eq(vouchers.id, existingPO.voucherId))
      .limit(1);
    if (currentVoucher) {
      actualDbVoucherTotal = toMoney(currentVoucher.totalAmount);
    }
  }
  const voucherTotalMismatch = actualDbVoucherTotal !== null && differs(newLocalVoucherTotal, actualDbVoucherTotal);

  // Determine whether the PO is on the parent company (or no interco at all).
  // Used inside the transaction to pick the right voucher structure.
  const _pfParentId = linkedParentCompanyId;
  const _isSameCompanyOrNoInterco = !_pfParentId || existingPO.companyId === _pfParentId;
  const _poContainerNum = existingPO.containerId
    ? ((
        await tx
          .select({ containerNumber: containers.containerNumber })
          .from(containers)
          .where(eq(containers.id, existingPO.containerId))
          .limit(1)
      )[0]?.containerNumber ?? null)
    : null;
  const _freightNarration = `Freight - ${existingPO.poNumber}${_poContainerNum ? ` (${_poContainerNum})` : ""}`;

  return { updated, voucherTotalMismatch, _pfParentId, _isSameCompanyOrNoInterco, _freightNarration };
}
