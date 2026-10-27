import type { Container } from "@shared/schema";

export type ContainerWithOffloadingCost = Container & { offloadingCost?: string | null };

/** The purchase-order grand total already includes the PO's own charges. */
export function getContainerOffloadingCost(container: ContainerWithOffloadingCost): number {
  if (container.status !== "OFFLOADED") return 0;
  const amount = Number(container.offloadingCost ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

/** Display-only landed cost: PO total + separate offload costs, counted once. */
export function getContainerTotalCost(container: ContainerWithOffloadingCost): number {
  const grandTotal = Number(container.grandTotal ?? 0);
  const itemsTotal = Number(container.itemsTotal ?? 0);
  const purchaseCost = Number.isFinite(grandTotal) && grandTotal !== 0
    ? grandTotal
    : (Number.isFinite(itemsTotal) ? itemsTotal : 0);
  // Round at the cent boundary to prevent binary floating-point display drift.
  return Math.round((purchaseCost + getContainerOffloadingCost(container)) * 100) / 100;
}
