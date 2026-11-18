// Extracted from ./FixedProductionPlannerDialog.tsx to keep that module under the source-size cap.
import { getApiRequest } from "@/lib/factoryApi";
import type { RawStockRow } from "./RawStockTable";
import type { OffloadSupplierOption } from "./offloadDialogTypes";

export interface FixedProductionPlannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rawStock: RawStockRow[];
  rawStockLoading: boolean;
  rawStockError: boolean;
  suppliers: OffloadSupplierOption[];
  suppliersLoading: boolean;
  suppliersError: boolean;
}

export interface PlannerRecord {
  allocations20t: Record<string, number>;
  locked: boolean;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface OtwContainer {
  id: number;
  supplierId: number | null;
  totalKg: string | null;
  status: string;
}

export const PLAN_KEY = ["/api/factory/raw-stock/fixed-production-planner"] as const;

export const OTW_KEY = ["/api/factory/containers?activeOnly=true"] as const;

export const CATEGORIES_KEY = ["/api/factory/supplier-categories"] as const;

// These private cache keys deliberately do not alias live Factory queries.
// The planner is a user-controlled snapshot, never an observer of background
// websocket invalidations, focus/reconnect events, or other pages' refetches.
export const PLAN_SNAPSHOT_KEY = ["fixed-production-planner-snapshot", "plan"] as const;

export const OTW_SNAPSHOT_KEY = ["fixed-production-planner-snapshot", "otw"] as const;

export const CATEGORIES_SNAPSHOT_KEY = ["fixed-production-planner-snapshot", "categories"] as const;

export const apiRequest = getApiRequest("factory");
