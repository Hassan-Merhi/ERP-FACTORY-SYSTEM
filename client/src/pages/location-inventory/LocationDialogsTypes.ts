// Extracted from ./LocationDialogs.tsx to keep that module under the source-size cap.
import type {
  InventoryLocation as Location,
  PendingMutation,
  RenameLocationVariables,
  StockGroupSummary,
  StockMovementItem,
  StockMovementMonth,
  StockMovementPeriod,
  WhatsappGroup,
  WhatsappGroupVariables,
  WhatsappTestVariables,
} from "./locationInventoryTypes";

export interface LocationDialogsProps {
  // Rename Dialog
  renameDialogOpen: boolean;
  setRenameDialogOpen: (o: boolean) => void;
  renamingLocation: Location | null;
  renameInput: string;
  setRenameInput: (s: string) => void;
  renameDeductionInput: string;
  setRenameDeductionInput: (s: string) => void;
  renameLocationMutation: PendingMutation<RenameLocationVariables>;

  // Delete Dialog
  deleteDialogOpen: boolean;
  setDeleteDialogOpen: (o: boolean) => void;
  isDeleting: boolean;
  handleDeleteLocation: () => void;
  selectedLocationLocal: Location | null;

  // Archive Dialog
  archiveDialogOpen: boolean;
  setArchiveDialogOpen: (o: boolean) => void;
  isArchiving: boolean;
  handleArchiveStockGroup: () => void;
  selectedGroup: StockGroupSummary | null;

  // WhatsApp Dialog
  waGroupDialogOpen: boolean;
  setWaGroupDialogOpen: (o: boolean) => void;
  waChats: WhatsappGroup[];
  waChatsLoading: boolean;
  waGroupSearch: string;
  setWaGroupSearch: (s: string) => void;
  waGroupSelectedId: string;
  setWaGroupSelectedId: (s: string) => void;
  waGroupMutation: PendingMutation<WhatsappGroupVariables>;
  waTestMutation: PendingMutation<WhatsappTestVariables>;
  waGroupLocation: Location | null;

  // Stock Movement Dialog
  stockMovementOpen: boolean;
  setStockMovementOpen: (o: boolean) => void;
  stockMovementItem: StockMovementItem | null;
  setStockMovementItem: (item: StockMovementItem | null) => void;
  stockMovementPeriod: StockMovementPeriod;
  setStockMovementPeriod: (period: StockMovementPeriod) => void;
  drillMonth: StockMovementMonth | null;
  setDrillMonth: (month: StockMovementMonth | null) => void;
  formatAmount: (amt: number) => string;
  navigate: (path: string) => void;
}
