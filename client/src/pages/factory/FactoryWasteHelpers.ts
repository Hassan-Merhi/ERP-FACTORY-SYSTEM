// Extracted from ./FactoryWaste.tsx

export interface WasteEntry {
  id: number;
  date: string;
  wasteType: string | null;
  kgWaste: number;
  reason: string | null;
  mixBatchId: number | null;
  supplierId: number | null;
  containerId: number | null;
}

export function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: from.toLocaleDateString("en-CA"),
    to: to.toLocaleDateString("en-CA"),
  };
}
