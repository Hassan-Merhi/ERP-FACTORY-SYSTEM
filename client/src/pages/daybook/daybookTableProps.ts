// Extracted from ./DaybookTable.tsx to keep that module under the source-size cap.
import type { DaybookRow, Voucher, ViewVoucherEntry } from "./types";

export interface DaybookTableProps {
  displayedRows: DaybookRow[];
  visibleRows: DaybookRow[];
  offloadAlphabetical?: boolean;
  viewMode: "detailed" | "condensed";
  selectedRowId: string | null;
  setSelectedRowId: (id: string | null) => void;
  hiddenRowIds: Set<string>;
  setHiddenRowIds: (ids: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  showHidden: boolean;
  expandedVoucherId: number | null;
  linkedVoucherIds: ReadonlySet<number>;
  setExpandedVoucherId: (id: number | null) => void;
  expandedCondensedGroups: Set<string>;
  setExpandedCondensedGroups: (ids: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  hideAmounts: boolean;
  accountNameCache: Record<number, string>;
  expandedLoading: boolean;
  expandedEntries: ViewVoucherEntry[];
  formatAmount: (amt: number | string | null | undefined) => string;
  formatTransactionAmount?: (amt: number | string | null | undefined, currency: string) => string;
  formatDisplayDate: (date: Date | string) => string;
  formatDisplayTime: (date: string) => string;
  handleView: (v: Voucher) => void;
  handleEdit: (v: Voucher) => void;
  handleDelete: (v: Voucher) => void;
  canEdit: (v: Voucher) => boolean;
  canDelete: () => boolean;
  daybookRowLimit: number;
  setDaybookRowLimit: (n: number | ((prev: number) => number)) => void;
  DAYBOOK_PAGE_SIZE: number;
  navigate: (path: string) => void;
  isLoading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
}
