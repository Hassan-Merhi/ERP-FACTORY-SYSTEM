import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import type { LedgerAccount, BankAccount, Supplier, Employee, FixedAsset } from "./types";

export function AccountCombobox({
  value,
  onChange,
  ledgerAccounts,
  bankAccounts,
  suppliers,
  employees,
  fixedAssets,
  rowIndex,
  testIdPrefix = "button-account",
}: {
  value: { type: string; id: number; name: string } | null;
  onChange: (type: "ledger" | "bank" | "supplier" | "employee" | "fixedAsset", id: number, name: string) => void;
  ledgerAccounts: LedgerAccount[];
  bankAccounts: BankAccount[];
  suppliers: Supplier[];
  employees: Employee[];
  fixedAssets: FixedAsset[];
  rowIndex: number;
  testIdPrefix?: string;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onArrowRight?: () => void;
}) {
  const accounts = [
    ...ledgerAccounts.map((a) => ({ type: "ledger" as const, id: a.id, name: a.name })),
    ...bankAccounts.map((a) => ({ type: "bank" as const, id: a.id, name: a.bankName })),
    ...suppliers.map((a) => ({ type: "supplier" as const, id: a.id, name: a.legalName })),
    ...employees.map((a) => ({ type: "employee" as const, id: a.id, name: `${a.firstName} ${a.lastName}` })),
    ...fixedAssets.map((a) => ({ type: "fixedAsset" as const, id: a.id, name: a.assetName })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <UnifiedAccountPicker
      options={accounts.map((a) => ({ value: `${a.type}:${a.id}`, name: a.name }))}
      value={value ? `${value.type}:${value.id}` : ""}
      selectedFallbackName={value?.name}
      onChange={(next) => {
        const selected = accounts.find((a) => `${a.type}:${a.id}` === next);
        if (selected) onChange(selected.type, selected.id, selected.name);
      }}
      placeholder="Select account..."
      testId={`${testIdPrefix}-${rowIndex}`}
      optionTestId={(key) => `option-account-${key.replace(":", "-")}`}
    />
  );
}
