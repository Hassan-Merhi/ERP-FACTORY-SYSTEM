// Extracted from ./AccountMigration.tsx to keep that module under the source-size cap.
import { X } from "lucide-react";
import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import type { Company, LedgerAccount } from "@shared/schema";

export interface AccountPreviewItem {
  account: LedgerAccount;
  entryCount: number;
  postedEntryCount: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  touchedVoucherCount: number;
  exclusiveVoucherCount: number;
  sharedVoucherCount: number;
  codeConflict: { id: number; name: string } | null;
}

export interface PreviewResult {
  accounts: AccountPreviewItem[];
  srcCompany: Company;
  destCompany: Company;
  grandTotalEntries: number;
  grandHistoryEntries: number;
  grandClosing: number;
  grandTotalDebit: number;
  grandTotalCredit: number;
}

interface ExecuteAccountResult {
  accountId: number;
  accountName: string;
  originalCode: string;
  finalCode: string;
  entryCount: number;
  wasRenamed: boolean;
}

export interface PendingMigration {
  migrationId: string;
  srcCompanyId: number;
  destCompanyId: number;
  accountIds: number[];
  movedVoucherIds: number[];
  accounts: Array<{ accountId: number; originalCode: string; finalCode: string }>;
}

export interface ExecuteResult {
  success: boolean;
  srcCompanyId: number;
  destCompanyId: number;
  totalEntries: number;
  movedVoucherIds: number[];
  movedVoucherCount: number;
  sharedVoucherCount: number;
  accounts: ExecuteAccountResult[];
}

export function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtSigned(n: number) {
  return `$ ${fmt(Math.abs(n))} ${n < 0 ? "Cr" : "Dr"}`;
}

export function CompanyBadge({ company }: { company?: Company }) {
  if (!company) return null;
  const typeColors: Record<string, string> = {
    erp: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    factory: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    factory_v2: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    properties: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  };
  const label =
    company.companyType === "erp"
      ? "ERP"
      : company.companyType === "factory" || company.companyType === "factory_v2"
        ? "Factory"
        : "Properties";
  return (
    <span
      className={`text-xs font-medium px-1.5 py-0.5 rounded-sm ${typeColors[company.companyType] ?? typeColors.erp}`}
    >
      {label}
    </span>
  );
}

interface AccountMultiSelectProps {
  accounts: LedgerAccount[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}

export function AccountMultiSelect({ accounts, selectedIds, onChange, disabled }: AccountMultiSelectProps) {
  const sorted = [...accounts].sort((a, b) => a.name.localeCompare(b.name));
  const selectedSet = new Set(selectedIds);

  function toggle(id: number) {
    if (selectedSet.has(id)) onChange(selectedIds.filter((item) => item !== id));
    else onChange([...selectedIds, id]);
  }

  return (
    <div className="space-y-2">
      <UnifiedAccountPicker
        mode="multiple"
        options={sorted.map((account) => ({ value: String(account.id), name: account.name }))}
        selectedValues={selectedIds.map(String)}
        onSelectedValuesChange={(values) => onChange(values.map(Number))}
        placeholder="Search accounts..."
        searchPlaceholder="Search account name..."
        contentClassName="w-[min(560px,calc(100vw-2rem))]"
        testId="select-accounts"
        disabled={disabled}
      />
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((id) => {
            const account = accounts.find((candidate) => candidate.id === id);
            if (!account) return null;
            return (
              <div key={id} className="flex max-w-[240px] items-center gap-1 rounded-md bg-muted px-2 py-1 text-sm">
                <span className="truncate">{account.name}</span>
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                  data-testid={`remove-account-${id}`}
                  disabled={disabled}
                  aria-label={`Remove ${account.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
