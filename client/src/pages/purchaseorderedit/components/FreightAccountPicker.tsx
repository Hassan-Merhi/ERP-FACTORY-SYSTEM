import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";

/** Freight posting account choice; codes and account types remain internal. */
export function FreightAccountPicker({
  value,
  onValueChange,
  accounts,
}: {
  value: string;
  onValueChange: (value: string) => void;
  accounts: Array<{ id: number; name: string }>;
}) {
  return (
    <UnifiedAccountPicker
      options={accounts.map((account) => ({ value: String(account.id), name: account.name }))}
      value={value}
      onChange={onValueChange}
      placeholder="Select account..."
      testId="button-freight-account"
    />
  );
}
