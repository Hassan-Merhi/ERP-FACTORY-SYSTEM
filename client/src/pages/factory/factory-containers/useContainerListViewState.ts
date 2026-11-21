// Extracted from ./ContainerListView.tsx
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { type ContainerWithSupplier } from "./otwHelpers";
import { type ContainerListViewProps } from "./ContainerListViewHelpers";

export function useContainerListViewState({
  filteredContainers,
  setExpandedSuppliers,
}: Pick<ContainerListViewProps, "filteredContainers" | "setExpandedSuppliers">) {
  const recordChanges = useExistingRecordChangeAccess();
  const recordChangeReason = recordChanges.reason ?? undefined;
  const toggleSupplier = (key: string) => {
    setExpandedSuppliers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Group containers by supplier
  const groups: { supplierKey: string; supplierName: string; containers: ContainerWithSupplier[] }[] = [];
  const seenKeys = new Map<string, number>();
  for (const c of filteredContainers || []) {
    const key = c.supplierName || "__none__";
    if (!seenKeys.has(key)) {
      seenKeys.set(key, groups.length);
      groups.push({ supplierKey: key, supplierName: c.supplierName || "No Supplier", containers: [] });
    }
    groups[seenKeys.get(key)!].containers.push(c);
  }
  return { recordChanges, recordChangeReason, toggleSupplier, groups };
}
