import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Upload, Users, X } from "lucide-react";
import type { Customer } from "./types";

interface FactoryProformasHeaderProps {
  customerId: number | null;
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
    customerId,
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
  return (
    <>
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-6 pt-6 pb-4 border-b">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Customer Proformas</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Price lists for bale sales per customer</p>
        </div>
        {customerId && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
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
            <Button size="sm" data-testid="button-create-proforma" onClick={() => setIsCreateOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New Proforma
            </Button>
          </div>
        )}
      </div>

      {/* ── Customer picker ──────────────────────────────────────────────── */}
      <div className="px-6 py-4 border-b bg-muted/30">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 min-w-[220px] flex-1 max-w-sm">
            <Users className="h-4 w-4 text-muted-foreground shrink-0" />
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
                <SelectTrigger data-testid="select-customer" className="flex-1">
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
                className="pl-8 h-9 w-52 text-sm"
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
