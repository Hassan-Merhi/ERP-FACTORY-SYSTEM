// Extracted from ./SupplierTrackingDefaultsTab.tsx

export interface TrackingDefaultSupplier {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  locationId: number | null;
  agentName: string | null;
  shopName: string | null;
  dutyFee: string | null;
}

interface TrackingLocation {
  id: number;
  code: string;
  name: string;
}

export interface TrackingDefaultsResponse {
  suppliers: TrackingDefaultSupplier[];
  locations: TrackingLocation[];
  agentOptions: string[];
}

export interface DraftValue {
  shopName: string;
  agentName: string;
  dutyFee: string;
}

export function toDraft(row: TrackingDefaultSupplier): DraftValue {
  return {
    shopName: row.shopName ?? "",
    agentName: row.agentName ?? "",
    dutyFee: row.dutyFee ?? "",
  };
}
