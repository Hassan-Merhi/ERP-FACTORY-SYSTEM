import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";

interface Account {
  id: number;
  name: string;
}

interface Props {
  id: string;
  accounts: Account[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function FactoryLoadingDispatchLedgerAccountPicker({
  id,
  accounts,
  value,
  onChange,
  placeholder = "Search ledger account",
}: Props) {
  return (
    <UnifiedAccountPicker
      id={id}
      options={accounts.map((account) => ({ value: String(account.id), name: account.name }))}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel={placeholder}
      className="h-9"
    />
  );
}
