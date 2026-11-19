// Extracted from ./CostCenterHistorical.tsx
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MultiSelectFilter } from "@/pages/factory/productioncomparison/components/MultiSelectFilter";
import { MAX_BATCH, type Kind } from "./CostCenterHistoricalTypes";
import { useCostCenterHistoricalState } from "./useCostCenterHistoricalState";

export function CostCenterHistoricalContent({
  accounts,
  from,
  invalidatePreview,
  isFactory,
  kind,
  limit,
  selectedAccounts,
  setFrom,
  setKind,
  setLimit,
  setSelectedAccounts,
  setTo,
  to,
}: Pick<
  ReturnType<typeof useCostCenterHistoricalState>,
  | "accounts"
  | "from"
  | "invalidatePreview"
  | "isFactory"
  | "kind"
  | "limit"
  | "selectedAccounts"
  | "setFrom"
  | "setKind"
  | "setLimit"
  | "setSelectedAccounts"
  | "setTo"
  | "to"
>) {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
      <div className="space-y-1">
        <Label>Historical Source</Label>
        <Select
          value={kind}
          onValueChange={(v) => {
            invalidatePreview();
            setKind(v as Kind);
            setSelectedAccounts([]);
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="VOUCHER_ENTRY">Posted expense voucher lines</SelectItem>
            {isFactory && <SelectItem value="FACTORY_DAYBOOK">Standalone Factory expenses</SelectItem>}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="historical-cc-from">From</Label>
        <Input
          id="historical-cc-from"
          type="date"
          value={from}
          onChange={(e) => {
            invalidatePreview();
            setFrom(e.target.value);
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="historical-cc-to">To</Label>
        <Input
          id="historical-cc-to"
          type="date"
          value={to}
          onChange={(e) => {
            invalidatePreview();
            setTo(e.target.value);
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="historical-cc-limit">Maximum entries (1–10,000)</Label>
        <Input
          id="historical-cc-limit"
          type="number"
          min={1}
          max={MAX_BATCH}
          step={1}
          value={limit}
          onChange={(e) => {
            invalidatePreview();
            setLimit(e.target.value);
          }}
        />
      </div>
      {kind === "VOUCHER_ENTRY" && (
        <div className="space-y-1 sm:col-span-2">
          <Label>Expense Ledger Accounts (optional)</Label>
          <MultiSelectFilter
            className="w-full"
            contentClassName="w-[min(28rem,90vw)]"
            testId="historical-cc-accounts"
            options={(accounts?.accounts || []).map((a) => ({
              value: String(a.id),
              label: a.code + " — " + a.name,
            }))}
            selected={selectedAccounts}
            onChange={(next) => {
              invalidatePreview();
              setSelectedAccounts(next);
            }}
            placeholder="Expense accounts"
            allLabel="All Eligible Expense Accounts"
          />
        </div>
      )}
    </div>
  );
}
