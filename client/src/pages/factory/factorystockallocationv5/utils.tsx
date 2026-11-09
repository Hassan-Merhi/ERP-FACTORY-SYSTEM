/**
 * Pure helpers and lookup tables for the FactoryStockAllocationV5 page.
 *
 * Extracted from FactoryStockAllocationV5.tsx during the Phase 4 god-file split.
 */

import { FACTORY_ALLOCATION_STATUS_LABELS } from "@shared/factoryStatusPresentation";

/** Backward-compatible V5 label export; workflow-specific labels owned in shared Factory presentation. */
export const STATUS_LABELS: Readonly<Record<string, string>> = FACTORY_ALLOCATION_STATUS_LABELS;

/* ═══════════════════════════════════════════════════════════════════════════ */
