// Extracted from ./AccountTransfer.tsx to keep that module under the source-size cap.
import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import { formatUsd } from "@/lib/moneyDisplay";

export type Account = { id: number; name: string; code: string; accountType: string };

type Entry = {
  id: number;
  voucherId: number;
  narration: string | null;
  debitAmount: string;
  creditAmount: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  voucherDescription: string | null;
};

export type EntryPage = {
  items: Entry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

export const ENTRY_PAGE_SIZE = 100;

export function fmtMoney(v: string | number | null | undefined) {
  if (!v || v === "0" || v === "0.00") return null;
  return formatUsd(Number(v), 2);
}

export function AccountCombobox({
  accounts,
  value,
  onChange,
  placeholder,
  excludeId,
  testId,
}: {
  accounts: Account[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder: string;
  excludeId?: number | null;
  testId: string;
}) {
  return (
    <UnifiedAccountPicker
      options={accounts
        .filter((account) => account.id !== excludeId)
        .map((account) => ({ value: String(account.id), name: account.name }))}
      value={value == null ? "" : String(value)}
      onChange={(next) => onChange(next ? Number(next) : null)}
      placeholder={placeholder}
      testId={testId}
      optionTestId={(id) => `${testId}-option-${id}`}
      allowClear
    />
  );
}
