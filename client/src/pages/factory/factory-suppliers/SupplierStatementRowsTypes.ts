// Extracted from ./SupplierStatementRows.tsx
import { StatementResponse, type StatementDisplayRow } from "./factorySupplierTypes";

export interface SupplierStatementRowsProps {
  statementData: StatementResponse;
  primaryCc: string;
  sfTotalPurchases: number;
  sfTotalPayments: number;
  sfPurchasesQty: number;
  sfTxCount: number;
  currencyTotals: Record<string, number>;
  statDateFilter: "all" | "today" | "yesterday" | "this_month" | "this_year";
  setStatDateFilter: (val: "all" | "today" | "yesterday" | "this_month" | "this_year") => void;
  displayedRows: StatementDisplayRow[];
  balanceByKey: Record<string, { bal: number; cc: string }>;
  formatDate: (val: string) => string;
  formatNum: (val: string) => string;
  typeBadge: (type: string) => React.ReactNode;
  statusDisplayLabel: (status: string) => string;
  onEditPayment: (p: Record<string, unknown>) => void;
  onDeletePayment: (id: number) => void;
}

export interface StatementExportRow {
  date: string;
  type: string;
  reference: string;
  status: string;
  detail: string;
  amount: string;
  balance: string;
}
