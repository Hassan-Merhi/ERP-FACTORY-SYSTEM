import {
  AlertTriangle,
  Building2,
  CalendarDays,
  CheckCircle2,
  Coins,
  Ellipsis,
  ReceiptText,
  Trash2,
  UsersRound,
} from "lucide-react";
import { rentalPaymentDateLabel, mayOfferRentalPaymentDelete } from "@/properties/config/rentalPaymentPresentation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { MoneyAmount } from "@/components/MoneyAmount";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cashCents } from "../paymentsReceiptMath";
import type { PaymentRow } from "../../RentalPaymentsLog";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type PaymentsPeriod = "all" | "30days" | "month" | "year";

type Option = { value: string; label: string };

/** Properties Payments Log body; the page header and export menu are the shared ones in RentalPaymentsLog. */
type Props = {
  payments: PaymentRow[];
  totalRecords: number;
  isLoading: boolean;
  isError: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  period: PaymentsPeriod;
  onPeriodChange: (value: PaymentsPeriod) => void;
  selectedUnit: string;
  onUnitChange: (value: string) => void;
  selectedTenant: string;
  onTenantChange: (value: string) => void;
  unitOptions: Option[];
  tenantOptions: Option[];
  totalAmount: string;
  amountLabel: string;
  /** Omitted for read-only roles: the delete action is hidden. */
  onDelete?: (payment: PaymentRow) => void;
};

export function PropertiesPaymentsPremium({
  payments,
  totalRecords,
  isLoading,
  isError,
  search,
  onSearchChange,
  period,
  onPeriodChange,
  selectedUnit,
  onUnitChange,
  selectedTenant,
  onTenantChange,
  unitOptions,
  tenantOptions,
  totalAmount,
  amountLabel,
  onDelete,
}: Props) {
  const uniqueTenants = new Set(payments.map((p) => p.tenantName).filter(Boolean)).size;
  const isFiltered = Boolean(search.trim()) || period !== "all" || selectedUnit !== "all" || selectedTenant !== "all";

  return (
    <div className="properties-payments-premium" data-testid="properties-payments-premium">
      <div className="properties-payments-summary" aria-label="Payment overview">
        <div className="properties-payments-stat properties-payments-stat--purple">
          <div className="properties-payments-stat-icon">
            <ReceiptText className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="properties-payments-stat-copy">
            <span>Total Payments</span>
            <strong data-testid="stat-prop-rental-total-payments">{isError ? "Unavailable" : payments.length}</strong>
          </div>
        </div>
        <div className="properties-payments-stat properties-payments-stat--green">
          <div className="properties-payments-stat-icon">
            <Coins className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="properties-payments-stat-copy">
            <span>{amountLabel}</span>
            <strong data-testid="stat-prop-rental-total-amount">{totalAmount}</strong>
          </div>
        </div>
        <div className="properties-payments-stat properties-payments-stat--blue">
          <div className="properties-payments-stat-icon">
            <UsersRound className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="properties-payments-stat-copy">
            <span>Unique Tenants</span>
            <strong>{isError ? "Unavailable" : uniqueTenants}</strong>
          </div>
        </div>
      </div>

      <div className="properties-payments-toolbar" role="search" aria-label="Filter payment history">
        <SearchField
          wrapperClassName="properties-payments-search"
          value={search}
          onValueChange={onSearchChange}
          placeholder="Search tenant, unit, notes, voucher…"
          aria-label="Search payment history"
          data-testid="input-prop-rental-payments-search"
        />
        <div className="properties-payments-select">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          <Select value={period} onValueChange={(value) => onPeriodChange(value as PaymentsPeriod)}>
            <SelectTrigger aria-label="Payment date range" data-testid="select-properties-payments-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Time</SelectItem>
              <SelectItem value="30days">Last 30 Days</SelectItem>
              <SelectItem value="month">This Month</SelectItem>
              <SelectItem value="year">This Year</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="properties-payments-select">
          <Building2 className="h-4 w-4" aria-hidden="true" />
          <Select value={selectedUnit} onValueChange={onUnitChange}>
            <SelectTrigger aria-label="Filter by unit" data-testid="select-properties-payments-unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Units</SelectItem>
              {unitOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="properties-payments-select">
          <UsersRound className="h-4 w-4" aria-hidden="true" />
          <Select value={selectedTenant} onValueChange={onTenantChange}>
            <SelectTrigger aria-label="Filter by tenant" data-testid="select-properties-payments-tenant">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tenants</SelectItem>
              {tenantOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isError && (
        <p role="alert" className="properties-payments-error">
          Could not retrieve the complete payment history. Totals are unavailable; no accounting data has been changed.
        </p>
      )}

      <div className="properties-payments-table-shell">
        <div className="properties-payments-table-scroll" data-horizontal-scroll="true">
          {isLoading ? (
            <LoadingState title="Loading payments…" />
          ) : isError ? (
            <ErrorState title="Payment history could not be loaded. Please retry." />
          ) : payments.length === 0 ? (
            <EmptyState
              icon={ReceiptText}
              title={totalRecords === 0 ? "No payments recorded yet." : "No payments match the current filters."}
            />
          ) : (
            <table className="properties-payments-table" data-testid="table-prop-rental-payments">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Client / Tenant</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className="properties-payments-right">
                    Cash Received
                  </th>
                  <th scope="col">For Month</th>
                  <th scope="col">Notes</th>
                  <th scope="col">Daybook</th>
                  <th scope="col" aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const readOnly = !mayOfferRentalPaymentDelete(p.sourceModule, p.readOnly, "PROPERTIES");
                  return (
                    <tr key={p.id} data-testid={`row-payment-${p.id}`}>
                      <td data-label="Date">
                        <span className="properties-payments-date">
                          <CalendarDays className="h-4 w-4" aria-hidden="true" />
                          {rentalPaymentDateLabel(p.paymentDate)}
                        </span>
                      </td>
                      <td data-label="Client / Tenant" className="properties-payments-tenant">
                        {p.tenantName ?? "—"}
                      </td>
                      <td data-label="Unit">
                        <span className="properties-payments-unit">{p.unitNumber ?? "—"}</span>
                        {p.locationGroup && <span className="properties-payments-location">{p.locationGroup}</span>}
                      </td>
                      <td data-label="Cash Received" className="properties-payments-right">
                        {cashCents(p) !== 0 ? (
                          <span className="properties-payments-cash">
                            {p.currency?.trim() ? (
                              <MoneyAmount amount={cashCents(p) / 100} currency={p.currency} />
                            ) : (
                              <span title="Recorded currency not verified">
                                {(cashCents(p) / 100).toFixed(2)} (currency unverified)
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="properties-payments-empty">—</span>
                        )}
                      </td>
                      <td data-label="For Month">
                        <span className="properties-payments-month">
                          {MONTH_NAMES[p.forMonth]} {p.forYear}
                        </span>
                      </td>
                      <td data-label="Notes" className="properties-payments-notes">
                        {p.sourceModule === "ERP" && (
                          <Badge variant="outline" className="mr-1 text-[10px]">
                            ERP source
                          </Badge>
                        )}
                        {p.readOnly && (
                          <Badge variant="outline" className="mr-1 text-[10px]">
                            Voucher-only guarantee receipt
                          </Badge>
                        )}
                        {p.notes || (!p.readOnly ? "—" : "")}
                      </td>
                      <td data-label="Daybook">
                        {p.voucherId ? (
                          <span className="properties-payments-voucher">#{p.voucherId}</span>
                        ) : (
                          <span className="properties-payments-no-entry" title="No accounting entry">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            No entry
                          </span>
                        )}
                      </td>
                      <td data-label="Action">
                        {onDelete && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="properties-payments-row-menu"
                                aria-label={`Actions for payment ${p.id}`}
                                data-testid={`button-payment-menu-${p.id}`}
                              >
                                <Ellipsis className="h-4 w-4" aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={readOnly}
                                onSelect={() => onDelete(p)}
                                className="text-destructive focus:text-destructive"
                                data-testid={`button-delete-payment-${p.id}`}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                {readOnly ? "Read-only record" : "Delete payment"}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="properties-payments-footer" role="status" aria-live="polite">
          <span className="properties-payments-records">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            {isLoading ? (
              "Loading records…"
            ) : isError ? (
              "History unavailable"
            ) : (
              <>
                All <strong>{payments.length}</strong> {isFiltered ? "matching " : ""}records loaded
              </>
            )}
          </span>
          <span className="properties-payments-total">
            Total Amount: <strong>{totalAmount}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}
