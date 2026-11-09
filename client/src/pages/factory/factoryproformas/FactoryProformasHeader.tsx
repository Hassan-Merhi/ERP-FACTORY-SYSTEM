import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Boxes, FileText, Plus, Search, Upload, Users, Weight, Wallet, X } from "lucide-react";
import type { Customer, Proforma } from "./types";

interface FactoryProformasHeaderProps {
  /** False for Create Only: proforma create/import controls are hidden. */
  canCreate: boolean;
  customerId: number | null;
  proformas: Proforma[];
  proformasLoading: boolean;
  hideProformaPrice: boolean;
  formatAmount: (amount: number | string | null | undefined) => string;
  setExcelImportName: Dispatch<SetStateAction<string>>;
  setExcelImportLines: Dispatch<
    SetStateAction<{ articleCode: string; productName: string; quantity: string; pricePerBale: string }[]>
  >;
  setExcelImportErrors: Dispatch<SetStateAction<string[]>>;
  setIsExcelImportOpen: Dispatch<SetStateAction<boolean>>;
  setIsCreateOpen: Dispatch<SetStateAction<boolean>>;
  customersLoading: boolean;
  selectedCustomerId: string;
  setSelectedCustomerId: Dispatch<SetStateAction<string>>;
  setExpandedProformaIds: Dispatch<SetStateAction<Set<number>>>;
  setProformaSearch: Dispatch<SetStateAction<string>>;
  customers: Customer[];
  proformaSearch: string;
}

export function FactoryProformasHeader(props: FactoryProformasHeaderProps) {
  const {
    canCreate,
    customerId,
    proformas,
    proformasLoading,
    hideProformaPrice,
    formatAmount,
    setExcelImportName,
    setExcelImportLines,
    setExcelImportErrors,
    setIsExcelImportOpen,
    setIsCreateOpen,
    customersLoading,
    selectedCustomerId,
    setSelectedCustomerId,
    setExpandedProformaIds,
    setProformaSearch,
    customers,
    proformaSearch,
  } = props;
  // These display-only totals use the existing API summaries, not accounting mutations.
  const activeProformas = proformas.filter((proforma) => proforma.isActive);
  const totalLines = activeProformas.reduce(
    (sum, proforma) => sum + Number(proforma.lineCount ?? proforma.lines?.length ?? 0),
    0
  );
  const totalBales = activeProformas.reduce((sum, proforma) => sum + Number(proforma.totalQty ?? 0), 0);
  const totalWeight = activeProformas.reduce((sum, proforma) => sum + Number(proforma.totalWeightKg ?? 0), 0);
  const totalAmount = activeProformas.reduce((sum, proforma) => sum + Number(proforma.totalAmount ?? 0), 0);

  return (
    <>
      {/* The same server-provided proforma summaries, without changing any saved values. */}
      {customerId && (
        <div className="grid grid-cols-2 gap-3 px-4 pt-5 sm:px-6 lg:grid-cols-4" aria-label="Active proforma overview">
          <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.12] to-fuchsia-500/[0.04] p-3.5 shadow-sm dark:border-violet-400/25 dark:from-violet-500/25 dark:to-fuchsia-600/[0.07]">
            <span className="rounded-xl bg-violet-500/15 p-2.5 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200">
              <FileText className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="text-xl font-bold tabular-nums">
                {proformasLoading ? "—" : totalLines.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">Total Lines</div>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.12] to-teal-500/[0.04] p-3.5 shadow-sm dark:border-emerald-400/25 dark:from-emerald-500/20 dark:to-teal-500/[0.06]">
            <span className="rounded-xl bg-emerald-500/15 p-2.5 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-200">
              <Boxes className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="text-xl font-bold tabular-nums">
                {proformasLoading ? "—" : totalBales.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">Total Bales</div>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-blue-500/20 bg-gradient-to-br from-blue-500/[0.12] to-cyan-500/[0.04] p-3.5 shadow-sm dark:border-blue-400/25 dark:from-blue-500/20 dark:to-cyan-500/[0.06]">
            <span className="rounded-xl bg-blue-500/15 p-2.5 text-blue-700 dark:bg-blue-400/20 dark:text-blue-200">
              <Weight className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="text-xl font-bold tabular-nums">
                {proformasLoading ? "—" : totalWeight.toLocaleString() + " kg"}
              </div>
              <div className="text-xs text-muted-foreground">Total Weight</div>
            </div>
          </div>
          {!hideProformaPrice && (
            <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.12] to-orange-500/[0.04] p-3.5 shadow-sm dark:border-amber-400/25 dark:from-amber-500/20 dark:to-orange-500/[0.06]">
              <span className="rounded-xl bg-amber-500/15 p-2.5 text-amber-700 dark:bg-amber-400/20 dark:text-amber-200">
                <Wallet className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="text-xl font-bold tabular-nums">
                  {proformasLoading ? "—" : formatAmount(totalAmount)}
                </div>
                <div className="text-xs text-muted-foreground">Total Amount</div>
              </div>
            </div>
          )}
        </div>
      )}
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 px-4 pb-4 pt-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-violet-500/10 p-2.5 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300">
            <Users className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Customer Proformas</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Price lists for bale sales per customer</p>
          </div>
        </div>
        {customerId && canCreate && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-xl border-border/70 bg-background/70 px-4 shadow-sm"
              data-testid="button-import-excel-proforma"
              onClick={() => {
                setExcelImportName("");
                setExcelImportLines([]);
                setExcelImportErrors([]);
                setIsExcelImportOpen(true);
              }}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import Excel
            </Button>
            <Button
              size="sm"
              className="h-9 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 text-white shadow-md shadow-violet-500/15 hover:from-violet-500 hover:to-indigo-500"
              data-testid="button-create-proforma"
              onClick={() => setIsCreateOpen(true)}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New Proforma
            </Button>
          </div>
        )}
      </div>

      {/* ── Customer picker ──────────────────────────────────────────────── */}
      <div className="mx-4 rounded-2xl border border-border/70 bg-card/70 px-4 py-4 shadow-sm dark:bg-slate-900/60 sm:mx-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 min-w-[220px] flex-1 max-w-sm">
            <Users className="h-4 w-4 text-violet-600 dark:text-violet-300 shrink-0" />
            {customersLoading ? (
              <Skeleton className="h-9 flex-1" />
            ) : (
              <Select
                value={selectedCustomerId}
                onValueChange={(val) => {
                  setSelectedCustomerId(val);
                  setExpandedProformaIds(new Set());
                  setProformaSearch("");
                }}
              >
                <SelectTrigger
                  data-testid="select-customer"
                  className="h-10 flex-1 rounded-xl border-border/70 bg-background/70"
                >
                  <SelectValue placeholder="Select a customer to view proformas..." />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()} data-testid={`select-customer-option-${c.id}`}>
                      {c.legalName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {customerId && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={proformaSearch}
                onChange={(e) => setProformaSearch(e.target.value)}
                placeholder="Search proformas…"
                className="h-10 w-52 rounded-xl border-border/70 bg-background/70 pl-8 text-sm sm:w-64"
                data-testid="input-proforma-search"
              />
              {proformaSearch && (
                <button
                  onClick={() => setProformaSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover-elevate rounded-sm"
                  data-testid="button-clear-proforma-search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
