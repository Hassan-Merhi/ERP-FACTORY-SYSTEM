// Extracted from ./SalesReportBySaleView.tsx
import type { VoucherGroup } from "../types";

type ItemColumnId =
  | "qty"
  | "costPrice"
  | "hassanPrice"
  | "pricePerBale"
  | "costProfitBale"
  | "hassanProfitBale"
  | "costProfitTotal"
  | "hassanProfitTotal";

export interface SalesReportBySaleViewProps {
  voucherGroups: VoucherGroup[];
  expandedVouchers: Set<number>;
  toggleVoucher: (id: number) => void;
  col: (id: ItemColumnId) => boolean;
  plFilter: "all" | "gain" | "loss";
  formatAmount: (amount: number | string | null | undefined) => string;
}
