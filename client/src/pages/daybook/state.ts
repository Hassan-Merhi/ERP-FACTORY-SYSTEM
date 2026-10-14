import type { PeriodFilterValue } from "@/components/ui/period-filter";

export interface DaybookUIState {
  periodFilter: PeriodFilterValue;
  filters: {
    voucherType: string;
    searchQuery: string;
    sortOrder: "asc" | "desc";
    minAmount: string;
    maxAmount: string;
    statusFilter: string;
  };
  selectedRowId: string | null;
  hiddenRowIds: string[];
  showHidden: boolean;
  scrollY: number;
  viewMode?: "detailed" | "condensed";
}

export const DAYBOOK_STATE_KEY = "erp-daybook-ui-state";

export function loadDaybookState(): DaybookUIState | null {
  try {
    const raw = sessionStorage.getItem(DAYBOOK_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DaybookUIState;
  } catch {
    return null;
  }
}

export function saveDaybookState(state: DaybookUIState | Partial<DaybookUIState>): void {
  try {
    const existing = loadDaybookState();
    const merged = existing ? { ...existing, ...state } : state;
    sessionStorage.setItem(DAYBOOK_STATE_KEY, JSON.stringify(merged));
  } catch {
    // sessionStorage may be unavailable in some contexts
  }
}
