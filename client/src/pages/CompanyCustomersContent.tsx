// Extracted from ./Customers.tsx
import { drCrClass } from "@/lib/formatNumber";
import { Building2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErpListTable, ErpRecordAction } from "@/erp-core";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompanyCustomersState } from "./useCompanyCustomersState";
import { ErrorState } from "@/components/ui/page-state";

type CustomerCurrencyBalances = Record<string, { debit: number; credit: number; net: number }>;

function getCustomerCurrencyBalances(customer: unknown): CustomerCurrencyBalances | undefined {
  if (!customer || typeof customer !== "object") return undefined;
  const balances = (customer as { balancesByCurrency?: unknown }).balancesByCurrency;
  return balances && typeof balances === "object" ? (balances as CustomerCurrencyBalances) : undefined;
}

export function CompanyCustomersContent({
  customers,
  customersError,
  filteredCustomers,
  formatHistoricalBaseAmount,
  handleEditClick,
  isLoading,
  recordChanges,
  refetchCustomers,
  searchQuery,
  selectedCompany,
  setStatementCustomer,
}: Pick<
  ReturnType<typeof useCompanyCustomersState>,
  | "customers"
  | "customersError"
  | "filteredCustomers"
  | "formatHistoricalBaseAmount"
  | "handleEditClick"
  | "isLoading"
  | "recordChanges"
  | "refetchCustomers"
  | "searchQuery"
  | "selectedCompany"
  | "setStatementCustomer"
>) {
  return (
    <div className="border rounded-xl overflow-hidden">
      <ErpListTable
        pageKey="customers"
        companyId={selectedCompany?.id}
        mobileLayout="cards"
        scrollLabel="Customer accounts"
      >
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="text-xs h-9 font-semibold">Customer</TableHead>
            <TableHead className="text-xs h-9 font-semibold text-right">Balance</TableHead>
            <TableHead className="text-xs h-9 font-semibold w-[60px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            [...Array(6)].map((_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Skeleton className="h-4 w-40" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-28" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-28 ml-auto" />
                </TableCell>
                <TableCell></TableCell>
              </TableRow>
            ))
          ) : customersError && customers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4}>
                <ErrorState onAction={() => void refetchCustomers()} actionLabel="Try again" className="my-2" />
              </TableCell>
            </TableRow>
          ) : filteredCustomers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4}>
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium">No customers found</p>
                  <p className="text-xs text-muted-foreground">
                    {searchQuery ? "Try a different search term" : "Add your first customer to get started"}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            filteredCustomers.map((customer) => (
              <TableRow
                key={customer.id}
                className="group cursor-pointer hover:bg-muted/40"
                data-testid={`row-customer-${customer.id}`}
                onClick={() => setStatementCustomer(customer)}
              >
                <TableCell className="py-3">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-medium text-sm" data-testid={`text-customer-name-${customer.id}`}>
                      {customer.legalName}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className={`font-mono font-semibold text-sm ${drCrClass(customer.balanceSide || "Dr")}`}>
                      {formatHistoricalBaseAmount(customer.balance || 0)}
                    </span>
                    <Badge variant="secondary" className={`text-xs ${drCrClass(customer.balanceSide || "Dr")}`}>
                      {customer.balanceSide || "Dr"}
                    </Badge>
                  </div>
                  {getCustomerCurrencyBalances(customer) &&
                    Object.keys(getCustomerCurrencyBalances(customer)!).length > 0 && (
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        Native:{" "}
                        {Object.entries(getCustomerCurrencyBalances(customer)!)
                          .map(
                            ([currency, value]) =>
                              `${currency} ${Math.abs(value.net).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                          )
                          .join(" · ")}
                      </div>
                    )}
                </TableCell>
                <TableCell className="py-3">
                  <div className="flex items-center justify-end opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity">
                    <ErpRecordAction
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (recordChanges.allowed) handleEditClick(customer);
                      }}
                      permitted={recordChanges.allowed}
                      deniedReason={recordChanges.reason}
                      aria-label={recordChanges.reason ?? "Edit customer"}
                      data-testid={`button-edit-customer-${customer.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </ErpRecordAction>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </ErpListTable>
    </div>
  );
}
