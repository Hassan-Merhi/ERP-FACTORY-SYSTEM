/**
 * Factory Daybook allocation surface.
 *
 * A voucher-backed row is tagged through its authoritative voucher entry;
 * a standalone factory expense is tagged through factory_daybook_entries.
 * Loading, raw-material offloads, freight, mixes, payroll cash movements and
 * any operational/mirrored entry are intentionally not independently allocatable.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Layers3 } from "lucide-react";
import { readCostCenterApi, type SourceCostCenterAllocation, type VoucherExpenseEntry } from "@/api/costCentersApi";
import {
  CostCenterEntryEditor,
  VoucherCostCenters,
  costCenterAccessDenied,
} from "@/components/financial/VoucherCostCenters";
import type { DaybookEntry } from "./types";

const STANDALONE_EXPENSE_TYPES = new Set(["EXPENSE", "OPERATING_EXPENSE", "FACTORY_EXPENSE"]);
const API_BASE = "/api/factory/cost-centers";

export function FactoryDaybookCostCenters({ entry }: { entry: DaybookEntry }) {
  const { selectedCompany } = useCompany();
  const role = selectedCompany?.role ?? "";
  const canRead = ["Admin", "Owner", "Developer", "Manager"].includes(role);
  const canWrite = ["Admin", "Owner", "Developer"].includes(role);
  const voucherBacked = entry.referenceTable?.toLowerCase() === "vouchers" && Number(entry.referenceId) > 0;
  const standalone =
    entry.id > 0 &&
    STANDALONE_EXPENSE_TYPES.has(entry.txType) &&
    // Same rule as the API and database: any reference means the expense is
    // recognized elsewhere (voucher, POS sale, document) and is tagged there.
    !(entry.referenceTable || "").trim() &&
    entry.referenceId == null;
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);
  const { data, isLoading, isError, error } = useQuery<SourceCostCenterAllocation>({
    queryKey: [API_BASE, selectedCompany?.id, "factory_daybook", entry.id, revision],
    queryFn: () => readCostCenterApi<SourceCostCenterAllocation>(API_BASE + "/allocations/factory_daybook/" + entry.id),
    enabled: canRead && standalone && !!selectedCompany?.id,
    staleTime: 30000,
  });
  if (!canRead) return null;

  // A Factory daybook voucher is a projection of the posted voucher, not
  // a second accounting event. It must not create a second analytical charge.
  // Its allocations belong to Vouchers; a Daybook-only viewer gets a 403 there
  // and VoucherCostCenters renders nothing.
  if (voucherBacked) return <VoucherCostCenters voucherId={Number(entry.referenceId)} />;
  if (!standalone) return null;
  // Standalone allocations belong to Daybook/Finance; hide the panel silently
  // rather than reporting the entry as ineligible when the page is not granted.
  if (isError && costCenterAccessDenied(error)) return null;

  const source: VoucherExpenseEntry = {
    entryId: entry.id,
    accountName: entry.description || "Factory operating expense",
    accountCode: "FACTORY_DAYBOOK",
    accountType: "Expense",
    costTreatment: "EXPENSE",
    currency: entry.currencyCode,
    amountNative: data?.totalNative ?? String(entry.amountCurrency),
    amountBase: data?.totalBase ?? String(entry.amountUsd),
    allocatedNative: data?.allocatedNative ?? "0",
    allocatedBase: data?.allocatedBase ?? "0",
    allocationCount: data?.splits?.length ?? 0,
  };
  return (
    <section aria-label="Factory cost center allocation" className="rounded-md border p-3 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Layers3 className="h-4 w-4" /> Cost Center Allocation
          </h3>
          <p className="text-xs text-muted-foreground">
            Standalone factory expense. Tracking only; no additional posting.
          </p>
        </div>
        {source.allocationCount > 0 && <Badge variant="secondary">{source.allocationCount} assigned</Badge>}
      </div>
      {isLoading && <p className="text-xs text-muted-foreground">Loading allocations…</p>}
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          This entry is not available for independent cost-center allocation.
        </p>
      )}
      {data && (
        <div className="flex flex-wrap gap-3 justify-between items-center">
          <div className="text-xs text-muted-foreground">
            {entry.currencyCode} {Number(source.allocatedNative).toLocaleString()} allocated · {entry.currencyCode}{" "}
            {Number(data.unallocatedNative).toLocaleString()} unallocated
          </div>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {canWrite ? "Assign / Split" : "View Allocations"}
          </Button>
        </div>
      )}
      {data && editing && (
        <CostCenterEntryEditor
          key={entry.id}
          entry={source}
          apiBase={API_BASE}
          sourceType="factory_daybook"
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setRevision((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}
