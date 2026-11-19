// Extracted from ./AgentCardTable.tsx
import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import type { AgentCardTableProps } from "./AgentCardTableTypes";

export function useAgentCardTableState(props: AgentCardTableProps) {
  const {
    prepaidTransitRows,
    visibleOpenPartial,
    openAndPartial,
    isReconciled,
    showCleared,
    effectivePrepaidIds,
    setAllPrepaidMutate,
    remainingTransitRows,
    setReplaceTarget,
    setReplaceAmountWarning,
    setReplaceConfirmDiff,
    moveRow,
    moveToTop,
    ledgerBalance,
    openSum,
    hasBalance,
    hasAdjustments,
    adjustedBalance,
    isMismatch,
    allBudgetDesignated,
    clearedRows,
  } = props;

  // ERP phones read each container as a card (labels from these headers); desktop keeps the grid.
  const { tableProps } = useMobileCardTable();
  const cols = [
    "CONTAINER",
    "SUPPLIER",
    "PLATE",
    "OFFLOAD DATE",
    "BORDER DATE",
    "TRANSPORTER",
    "LOCATION",
    "DUTY",
    "CLEARED",
    "REMAINING",
    "STATUS",
    "",
  ];
  return {
    prepaidTransitRows,
    remainingTransitRows,
    setReplaceTarget,
    setReplaceAmountWarning,
    setReplaceConfirmDiff,
    setAllPrepaidMutate,
    effectivePrepaidIds,
    isReconciled,
    visibleOpenPartial,
    moveToTop,
    moveRow,
    hasBalance,
    ledgerBalance,
    openSum,
    hasAdjustments,
    adjustedBalance,
    isMismatch,
    allBudgetDesignated,
    clearedRows,
    openAndPartial,
    showCleared,
    tableProps,
    cols,
  };
}
