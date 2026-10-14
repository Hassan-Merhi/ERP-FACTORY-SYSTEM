/**
 * Types for the FactoryOtwTrackingTab page.
 *
 * Extracted from FactoryOtwTrackingTab.tsx during the Phase 4 god-file split.
 */
import type {FactoryContainer} from "@shared/schema";

export // ── Types ───────────────────────────────────────────────────────────────────
interface ContainerWithSupplier extends FactoryContainer {
  supplierName?: string | null;
}

export interface OtwTrackingTabProps {
  onEdit?: (container: ContainerWithSupplier) => void;
}

