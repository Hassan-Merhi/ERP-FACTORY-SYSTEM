// Extracted from ./AccountStatementView.tsx to keep that module under the source-size cap.
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PeriodFilterValue } from "@/components/ui/period-filter";
import type { Account, Transaction, WaRule } from "./accountTypes";

interface AccountStatementRow extends Transaction {
  totalDebit: number;
  totalCredit: number;
  runningBalance: number;
}

export interface AccountStatementPageMetadata {
  customerId?: number;
  total?: number;
  periodDebitTotal?: number;
  periodCreditTotal?: number;
  closingNetBalance?: number;
}

interface StatementSendMutation {
  isPending: boolean;
  mutate: (input: { accountId: number; month: string }) => void;
}

export interface AccountStatementViewProps {
  selectedAccount: Account;
  onClose: () => void;
  periodFilter: PeriodFilterValue;
  setPeriodFilter: Dispatch<SetStateAction<PeriodFilterValue>>;
  vouchersWithBalance: AccountStatementRow[];
  statementCustomerId: number | null;
  closingBalance: number;
  openingBalance: number;
  transactionsLoading: boolean;
  transactionError?: string | null;
  selectedVoucherIds: Set<number>;
  toggleSelectAll: () => void;
  setShowBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  showDeletedVouchers: boolean;
  setShowDeletedVouchers: Dispatch<SetStateAction<boolean>>;
  formatAmount: (amt: number) => string;
  hideBalances: boolean;
  printRef: RefObject<HTMLDivElement | null>;
  appMode: string;
  formatDisplayDate: (date: Date | string) => string;
  toggleVoucherSelection: (id: number) => void;
  handleOpenVoucher: (voucher: AccountStatementRow) => void;
  waRule: WaRule | null;
  openWaRuleDialog: () => void;
  sendWaStatementMutation: StatementSendMutation;
  isBrokerSupplier: boolean;
  factoryStatementLoading: boolean;
  brokerStatementLoading: boolean;
}
