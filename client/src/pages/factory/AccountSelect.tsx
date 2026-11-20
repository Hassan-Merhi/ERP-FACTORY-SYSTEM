// Extracted from ./FactoryTransportersPaymentDialog.tsx
import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";

export const API = "/api/factory/transporters";

export type LedgerAccount = { id: number; name: string; accountType: string };

export type Transporter = {
  id: number;
  name: string;
  phone?: string;
  notes?: string;
  totalCharged: number;
  totalPaid: number;
  outstanding: number;
};

type Transaction = {
  id: number;
  txType: "charge" | "payment";
  amount: string;
  txDate: string;
  description?: string;
  runningBalance: number;
};

export type TransporterDetail = Transporter & { transactions: Transaction[] };

// ─────────────────────────────────────────────────────────────
// ACCOUNT COMBOBOX (simple select for now)
// ─────────────────────────────────────────────────────────────
export function AccountSelect({
  accounts,
  value,
  onChange,
  placeholder,
  filter,
}: {
  accounts: LedgerAccount[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  filter?: (a: LedgerAccount) => boolean;
}) {
  const list = filter ? accounts.filter(filter) : accounts;
  return (
    <UnifiedAccountPicker
      options={list.map((a) => ({ value: String(a.id), name: a.name }))}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel={placeholder}
    />
  );
}
