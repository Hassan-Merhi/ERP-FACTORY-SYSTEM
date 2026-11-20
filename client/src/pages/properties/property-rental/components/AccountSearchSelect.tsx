import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import type { CashAccount } from "../types";

/** Cash and bank options retain their existing IDs and eligibility rules. */
export function AccountSearchSelect({
  accounts,
  value,
  onChange,
  placeholder,
  testId,
}: {
  accounts: CashAccount[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <UnifiedAccountPicker
      options={accounts.map((account) => ({ value: String(account.id), name: account.name }))}
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? "Select account…"}
      testId={testId}
    />
  );
}
