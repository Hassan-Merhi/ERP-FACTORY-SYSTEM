// Extracted from ./AgentCardTable.tsx
import type { ApiAllocatedRow, ApiPreviewRow } from "./types";

interface ReplaceTargetLite {
  id: number;
  containerNumber: string;
  dutyFee: number;
}

export interface AgentCardTableProps {
  agentName: string;
  prepaidTransitRows: ApiPreviewRow[];
  visibleOpenPartial: ApiAllocatedRow[];
  openAndPartial: ApiAllocatedRow[];
  isReconciled: boolean;
  showCleared: boolean;
  setShowCleared: (v: boolean | ((prev: boolean) => boolean)) => void;
  isDbOverride: boolean;
  effectivePrepaidIds: number[];
  setAllPrepaidMutate: (ids: number[]) => void;
  remainingTransitRows: ApiPreviewRow[];
  setReplaceTarget: (t: ReplaceTargetLite | null) => void;
  setReplaceAmountWarning: (w: null) => void;
  setReplaceConfirmDiff: (b: boolean) => void;
  isCustomOrder: boolean;
  moveRow: (id: number, dir: "up" | "down") => void;
  moveToTop: (id: number) => void;
  ledgerBalance: number | null;
  openSum: number;
  hasBalance: boolean;
  hasAdjustments: boolean;
  adjustedBalance: number | null;
  isMismatch: boolean;
  allBudgetDesignated: boolean;
  clearedRows: ApiAllocatedRow[];
}
