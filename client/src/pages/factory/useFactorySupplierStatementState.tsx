// Extracted from ./FactorySupplierStatement.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { CurrencyGroup } from "./factory-suppliers/factorySupplierTypes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ApiListRow, AuthMe } from "@shared/apiTypes";

// ─── Row-total helpers ───────────────────────────────────────────────────────

/**
 * Canonical row total for the GOODS SUPPLIER perspective
 * (how much this supplier should receive for this container).
 *
 * Priority:
 *  1. `finalPayableAmount` (set at offload) — this is the ALL-IN company cost
 *     (base + freight + OC + commission + duty).  We display it as-is and note
 *     that commission is "incl. in total" so the user knows the breakdown.
 *  2. Pre-offload fallback: `value` only (kg × rate + same-currency freight).
 *     Commission is a SEPARATE obligation to the broker — it is not owed to this
 *     goods supplier, so we do NOT add it to the row total.
 *
 * The group "Net Owed to Supplier" footer uses the backend's netPayable field
 * (totalValue − effectiveCommission − paid) which correctly excludes the
 * commission from what this supplier receives.
 */
/** A row inside the supplier statement — base entry plus the extra fields the
 * broker-container view and commission display read. */
export interface StatementRow {
  id: number;
  name?: string;
  containerNumber?: string | null;
  status?: string;
  date?: string;
  arrivalDate?: string | null;
  origin?: string | null;
  supplierName?: string;
  value: string;
  totalKg?: string | null;
  ratePerKg?: string | null;
  actualReceivedKg?: string | null;
  finalPayableAmount?: string | null;
  commissionAmount?: string | null;
  commissionCurrencyCode?: string | null;
  totalCommission?: string;
}

export function getRowTotalOwed(c: StatementRow): number {
  const fp = parseFloat(c.finalPayableAmount ?? "");
  if (!isNaN(fp) && fp > 0) return fp;
  // Pre-offload: goods value only (no commission — that goes to the broker)
  return parseFloat(c.value || "0");
}

/** True when the row is using the backend canonical total (post-offload). */
export function rowUsesCanonical(c: StatementRow): boolean {
  const fp = parseFloat(c.finalPayableAmount ?? "");
  return !isNaN(fp) && fp > 0;
}

/**
 * Commission to display for a row.
 * Post-offload: use totalCommission (canonical factoryContainerCommissions sum).
 * Pre-offload: use commissionAmount (container-level estimate).
 */
export function rowCommissionDisplay(c: StatementRow): { amount: number; currency: string } {
  if (rowUsesCanonical(c)) {
    const tc = parseFloat(c.totalCommission ?? "0");
    if (tc > 0) return { amount: tc, currency: c.commissionCurrencyCode || "USD" };
  }
  return {
    amount: parseFloat(c.commissionAmount || "0"),
    currency: c.commissionCurrencyCode || "USD",
  };
}

export function useFactorySupplierStatementState() {
  const { formatDisplayDate } = useDateFormat();
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState<string>("");
  const [estimatedRates, setEstimatedRates] = useState<Record<string, string>>({});

  const { data: companies = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/user/companies"],
  });

  const { data: me } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const isAdmin = me?.role === "Admin" || me?.role === "Owner" || me?.role === "Developer";

  const { data: suppliers = [], isLoading: suppliersLoading } = useQuery<ApiListRow[]>({
    queryKey: ["/api/factory/suppliers", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/suppliers?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch suppliers");
      return res.json();
    },
    enabled: !!companyId,
  });
  const {
    data: statement,
    isLoading: statementLoading,
    isError: statementError,
    refetch: refetchStatement,
  } = useQuery({
    queryKey: ["/api/factory/suppliers", supplierId, "statement"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/suppliers/${supplierId}/statement`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch statement");
      return res.json();
    },
    enabled: !!supplierId,
  });

  const getRate = (cc: string) => parseFloat(estimatedRates[cc] || (cc === "USD" ? "1" : "0")) || 0;

  /**
   * Estimated USD total uses the per-currency NET PAYABLE (outstanding to the
   * goods supplier) — not totalOwed (which includes broker commission).
   * This gives a more accurate picture of what the company still owes each supplier.
   */
  const estimatedUsdTotal = statement?.currencyGroups
    ? statement.currencyGroups.reduce((sum: number, g: CurrencyGroup) => {
        const rate = getRate(g.currencyCode);
        // netPayable is what we still owe this supplier after deducting commission and payments.
        const outstanding = parseFloat(g.netPayable || "0");
        if (outstanding <= 0) return sum;
        return sum + outstanding * rate;
      }, 0)
    : 0;

  const currenciesInStatement: string[] = statement?.currencyGroups
    ? [...new Set<string>(statement.currencyGroups.map((g: CurrencyGroup) => g.currencyCode as string))].filter(
        (c) => c !== "USD"
      )
    : [];
  return {
    statementError,
    refetchStatement,
    companies,
    companyId,
    currenciesInStatement,
    estimatedRates,
    estimatedUsdTotal,
    formatDisplayDate,
    getRate,
    isAdmin,
    setCompanyId,
    setEstimatedRates,
    setSupplierId,
    statement,
    statementLoading,
    supplierId,
    suppliers,
    suppliersLoading,
  };
}

export function FactorySupplierStatementCardSection({
  companies,
  companyId,
  setCompanyId,
  setSupplierId,
  supplierId,
  suppliers,
  suppliersLoading,
}: Pick<
  ReturnType<typeof useFactorySupplierStatementState>,
  "companies" | "companyId" | "setCompanyId" | "setSupplierId" | "supplierId" | "suppliers" | "suppliersLoading"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Filters</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-4 flex-wrap">
          {companies.length > 1 && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Company</Label>
              <Select
                value={companyId ? String(companyId) : ""}
                onValueChange={(val) => {
                  setCompanyId(Number(val));
                  setSupplierId("");
                }}
              >
                <SelectTrigger className="w-48" data-testid="select-company">
                  <SelectValue placeholder="Select company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Supplier</Label>
            <Select
              value={supplierId || ""}
              onValueChange={(val) => setSupplierId(val)}
              disabled={!companyId || suppliersLoading}
            >
              <SelectTrigger className="w-56" data-testid="select-supplier">
                <SelectValue placeholder="Select supplier..." />
              </SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
