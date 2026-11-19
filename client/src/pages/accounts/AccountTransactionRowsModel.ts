// Extracted from ./AccountTransactionRows.tsx
import type { Account, Transaction } from "./accountTypes";

export const HISTORICAL_REFERENCE_TYPE = "Historical PO Reference";

export const HISTORICAL_FACTORY_INVOICE_TYPE = "Historical Factory Invoice";

export const ACCOUNT_ROW_HEIGHT = 56;

export interface AccountStatementRow extends Transaction {
  totalDebit: number;
  totalCredit: number;
  runningBalance: number;
}

export interface AccountTransactionRowsProps {
  vouchersWithBalance: AccountStatementRow[];
  selectedVoucherIds: Set<number>;
  toggleSelectAll: () => void;
  toggleVoucherSelection: (id: number) => void;
  handleOpenVoucher: (v: AccountStatementRow) => void;
  formatAmount: (amt: number) => string;
  formatTransactionAmount?: (amt: number | string, currency: string) => string;
  hideBalances: boolean;
  appMode: string;
  openingBalance: number;
  closingBalance: number;
  selectedAccount: Account;
  formatDisplayDate: (date: Date | string) => string;
  showCustomerDestination?: boolean;
  destinationFilter?: string;
}
