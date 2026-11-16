// Extracted from ./FactoryCustomers.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { drCrClass } from "@/lib/formatNumber";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, Columns3, Download, FileText, Pencil, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFactoryCustomersState } from "./useFactoryCustomersState";

export function FactoryCustomersSection({
  formatCashAmount,
  navigate,
  openEdit,
  pagedCustomers,
  prefs,
  recordChanges,
  search,
  setDeletingCustomer,
  showActionsColumn,
  showBalanceColumn,
  visibleCustomers,
  zeroBalanceCount,
}: Pick<
  ReturnType<typeof useFactoryCustomersState>,
  | "formatCashAmount"
  | "navigate"
  | "openEdit"
  | "pagedCustomers"
  | "prefs"
  | "recordChanges"
  | "search"
  | "setDeletingCustomer"
  | "showActionsColumn"
  | "showBalanceColumn"
  | "visibleCustomers"
  | "zeroBalanceCount"
>) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm dark:border-blue-400/20 dark:bg-slate-950/40">
      <div className="table-responsive">
        <Table mobileLayout="cards" density={prefs.density} wrapperClassName="border-0 rounded-none dark:border-0">
          <TableHeader className="sticky top-0 z-30">
            <TableRow className="bg-muted/65 hover:bg-muted/65 dark:bg-blue-900/25 dark:hover:bg-blue-900/25">
              <TableHead className="py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Name
              </TableHead>
              {showBalanceColumn && (
                <TableHead className="py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Balance
                </TableHead>
              )}
              {showActionsColumn && (
                <TableHead className="w-[144px] py-3 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleCustomers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={1 + Number(showBalanceColumn) + Number(showActionsColumn)}
                  className="text-center py-8 text-muted-foreground"
                >
                  {search
                    ? "No customers match your search"
                    : zeroBalanceCount > 0
                      ? "All customers currently have a zero balance"
                      : "No customers yet"}
                </TableCell>
              </TableRow>
            ) : (
              pagedCustomers.map((customer) => (
                <TableRow
                  key={customer.id}
                  className="hover:bg-blue-500/5 dark:hover:bg-blue-500/10"
                  data-testid={`row-customer-${customer.id}`}
                >
                  <TableCell className="py-3 font-medium sm:py-3" data-testid={`text-customer-name-${customer.id}`}>
                    <div className="flex items-center gap-3">
                      <div
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600/10 text-xs font-bold text-blue-600 dark:bg-blue-400/15 dark:text-blue-300"
                      >
                        {(customer.legalName ?? "")
                          .trim()
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((part) => part.charAt(0))
                          .join("")
                          .toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <button
                          className="text-left font-semibold text-foreground hover:underline"
                          onClick={() => navigate(`/factory/customers/${customer.id}`)}
                          data-testid={`button-open-statement-${customer.id}`}
                        >
                          {customer.legalName}
                        </button>
                        {customer.phone && <p className="mt-0.5 text-xs text-muted-foreground">{customer.phone}</p>}
                      </div>
                    </div>
                  </TableCell>
                  {showBalanceColumn && (
                    <TableCell className="py-3 text-right font-mono sm:py-3">
                      {customer.balance !== undefined ? (
                        <span
                          className={`text-sm font-bold tabular-nums ${Math.abs(customer.balance) <= 0.001 ? "text-muted-foreground" : drCrClass(customer.balanceSide)}`}
                          data-testid={`text-customer-balance-${customer.id}`}
                          title={customer.balanceSide?.toUpperCase() === "CR" ? "Credit balance" : "Debit balance"}
                          aria-label={`${formatCashAmount(customer.balance)} ${customer.balanceSide?.toUpperCase() === "CR" ? "credit" : "debit"} balance`}
                        >
                          {formatCashAmount(customer.balance)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  )}
                  {showActionsColumn && (
                    <TableCell className="py-3 sm:py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => navigate(`/factory/invoicing?tab=proformas&customerId=${customer.id}`)}
                          title="View Proformas"
                          aria-label={`View proformas for ${customer.legalName}`}
                          className="h-9 w-9 rounded-xl border border-border/60 hover:border-blue-400/60 hover:text-blue-500"
                          data-testid={`button-proformas-customer-${customer.id}`}
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(customer)}
                          disabled={!recordChanges.allowed}
                          title={recordChanges.reason ?? "Edit Customer"}
                          aria-label={recordChanges.reason ?? `Edit ${customer.legalName}`}
                          className="h-9 w-9 rounded-xl border border-border/60 hover:border-blue-400/60 hover:text-blue-500"
                          data-testid={`button-edit-customer-${customer.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <div className="w-px h-5 bg-border mx-0.5" />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeletingCustomer(customer)}
                          disabled={!recordChanges.allowed}
                          title={recordChanges.reason ?? "Delete Customer"}
                          aria-label={recordChanges.reason ?? `Delete ${customer.legalName}`}
                          className="h-9 w-9 rounded-xl border border-destructive/20 text-destructive hover:border-destructive/50 hover:bg-destructive/10"
                          data-testid={`button-delete-customer-${customer.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function FactoryCustomersSection2({
  balanceFilter,
  exportVisibleCustomers,
  refetchCustomers,
  setBalanceFilter,
  setColumnVisible,
  setPage,
  showActionsColumn,
  showBalanceColumn,
}: Pick<
  ReturnType<typeof useFactoryCustomersState>,
  | "balanceFilter"
  | "exportVisibleCustomers"
  | "refetchCustomers"
  | "setBalanceFilter"
  | "setColumnVisible"
  | "setPage"
  | "showActionsColumn"
  | "showBalanceColumn"
>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-2 rounded-xl"
            data-testid="button-customer-balance-filter"
          >
            <SlidersHorizontal className="h-4 w-4" /> Filters <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Balance side</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => {
              setBalanceFilter("all");
              setPage(1);
            }}
          >
            All balances {balanceFilter === "all" ? "✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setBalanceFilter("Dr");
              setPage(1);
            }}
          >
            Debit balances {balanceFilter === "Dr" ? "✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setBalanceFilter("Cr");
              setPage(1);
            }}
          >
            Credit balances {balanceFilter === "Cr" ? "✓" : ""}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 gap-2 rounded-xl" data-testid="button-customer-columns">
            <Columns3 className="h-4 w-4" /> Columns <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Visible columns (saved)</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked disabled>
            Name
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showBalanceColumn}
            onCheckedChange={(checked) => setColumnVisible("balance", checked)}
          >
            Balance
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showActionsColumn}
            onCheckedChange={(checked) => setColumnVisible("actions", checked)}
          >
            Actions
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="outline"
        size="sm"
        className="h-9 gap-2 rounded-xl"
        onClick={exportVisibleCustomers}
        data-testid="button-export-customers"
      >
        <Download className="h-4 w-4" /> Export
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9 rounded-xl"
        onClick={() => void refetchCustomers()}
        title="Refresh customers"
        aria-label="Refresh customers"
        data-testid="button-refresh-customers"
      >
        <RefreshCw className="h-4 w-4" />
      </Button>
    </div>
  );
}
