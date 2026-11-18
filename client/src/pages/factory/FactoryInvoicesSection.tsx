// Extracted from ./FactoryInvoices.tsx to keep that module under the source-size cap.
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Package } from "lucide-react";
import { InvoiceGroupRow } from "./factoryinvoices/InvoiceGroupRow";
import { InvoiceOrderRow } from "./factoryinvoices/InvoiceOrderRow";
import { useFactoryInvoicesStatePart1 } from "./useFactoryInvoicesStatePart1";
import { useFactoryInvoicesStatePart2 } from "./useFactoryInvoicesStatePart2";

export function useFactoryInvoicesState() {
  const {
    allOrders,
    allowedInvoiceColumns,
    changeCustomerMutation,
    changingCustomerOrderId,
    customGroupOrders,
    customerFilter,
    customers,
    downloadExport,
    dragIdxRef,
    dropIdx,
    expandedCustomers,
    formatDisplayDate,
    fromDate,
    hideMutation,
    hideTotalsUsd,
    isAdmin,
    isColumnVisible,
    isError,
    isLoading,
    modeApiRequest,
    navigate,
    newCustomerId,
    recordChanges,
    searchTerm,
    setChangingCustomerOrderId,
    setColumnVisible,
    setCustomGroupOrders,
    setCustomerFilter,
    setDropIdx,
    setFromDate,
    setNewCustomerId,
    setSearchTerm,
    setShowHidden,
    setShowMoreFilters,
    setStatusFilter,
    setTablePrefs,
    setToDate,
    shippingFieldMutation,
    showHidden,
    showMoreFilters,
    statusFilter,
    toDate,
    toast,
    toggleCustomer,
    visibleOptionalColumns,
  } = useFactoryInvoicesStatePart1();
  const {
    colCount,
    customerGroups,
    filteredOrders,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    handleDrop,
    orderRowContext,
    orderedCustomerGroups,
    scopedOrders,
    statusFilters,
  } = useFactoryInvoicesStatePart2({
    allOrders,
    customGroupOrders,
    customerFilter,
    downloadExport,
    dragIdxRef,
    formatDisplayDate,
    fromDate,
    hideMutation,
    isAdmin,
    isColumnVisible,
    modeApiRequest,
    navigate,
    recordChanges,
    searchTerm,
    setChangingCustomerOrderId,
    setCustomGroupOrders,
    setDropIdx,
    setNewCustomerId,
    shippingFieldMutation,
    showHidden,
    statusFilter,
    toDate,
    toast,
    visibleOptionalColumns,
  });
  return {
    allowedInvoiceColumns,
    changeCustomerMutation,
    changingCustomerOrderId,
    colCount,
    customerFilter,
    customerGroups,
    customers,
    dragIdxRef,
    dropIdx,
    expandedCustomers,
    filteredOrders,
    fromDate,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    handleDrop,
    hideTotalsUsd,
    isColumnVisible,
    isError,
    isLoading,
    newCustomerId,
    orderRowContext,
    orderedCustomerGroups,
    scopedOrders,
    searchTerm,
    setChangingCustomerOrderId,
    setColumnVisible,
    setCustomerFilter,
    setFromDate,
    setNewCustomerId,
    setSearchTerm,
    setShowHidden,
    setShowMoreFilters,
    setStatusFilter,
    setTablePrefs,
    setToDate,
    showHidden,
    showMoreFilters,
    statusFilter,
    statusFilters,
    toDate,
    toggleCustomer,
    visibleOptionalColumns,
  };
}

export function FactoryInvoicesSection({
  colCount,
  customerGroups,
  dragIdxRef,
  dropIdx,
  expandedCustomers,
  handleDragEnd,
  handleDragOver,
  handleDragStart,
  handleDrop,
  isColumnVisible,
  orderRowContext,
  orderedCustomerGroups,
  toggleCustomer,
}: Pick<
  ReturnType<typeof useFactoryInvoicesState>,
  | "colCount"
  | "customerGroups"
  | "dragIdxRef"
  | "dropIdx"
  | "expandedCustomers"
  | "handleDragEnd"
  | "handleDragOver"
  | "handleDragStart"
  | "handleDrop"
  | "isColumnVisible"
  | "orderRowContext"
  | "orderedCustomerGroups"
  | "toggleCustomer"
>) {
  return (
    <div className="overflow-x-auto">
      <Table className="text-xs [&_td]:px-2.5 [&_td]:py-2 [&_th]:h-10 [&_th]:px-2.5 [&_th]:py-2">
        <TableHeader>
          <TableRow className="border-b-2 border-border/60 bg-slate-100/80 hover:bg-slate-100/80 dark:bg-muted dark:hover:bg-muted">
            {/* Drag handle column */}
            <TableHead className="w-7 px-1" />
            <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Customer
            </TableHead>
            {isColumnVisible("loading") && (
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Loading #
              </TableHead>
            )}
            {isColumnVisible("proforma") && (
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Proforma
              </TableHead>
            )}
            {isColumnVisible("container") && (
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Container
              </TableHead>
            )}
            {isColumnVisible("bookingInfo") && (
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Booking Info
              </TableHead>
            )}
            {isColumnVisible("destination") && (
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Destination
              </TableHead>
            )}
            {isColumnVisible("notes") && (
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Notes
              </TableHead>
            )}
            {isColumnVisible("date") && (
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Date
              </TableHead>
            )}
            {isColumnVisible("status") && (
              <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Status
              </TableHead>
            )}
            {isColumnVisible("bales") && (
              <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Bales
              </TableHead>
            )}
            {isColumnVisible("weight") && (
              <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Weight
              </TableHead>
            )}
            {isColumnVisible("remaining") && (
              <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Remaining
              </TableHead>
            )}
            {isColumnVisible("extras") && (
              <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Extras
              </TableHead>
            )}
            {isColumnVisible("total") && (
              <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Total
              </TableHead>
            )}
            <TableHead className="w-[120px] text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customerGroups.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={colCount}
                className="text-center text-muted-foreground py-8"
                data-testid="text-no-orders"
              >
                <div className="flex flex-col items-center gap-2">
                  <Package className="h-10 w-10 opacity-40" />
                  <p>No invoices found</p>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            orderedCustomerGroups.map((group, groupIdx) => {
              const isSingle = group.orders.length === 1;
              const isExpanded = expandedCustomers.has(group.customerId);
              const isDragging = dragIdxRef.current === groupIdx;
              const isDropTarget =
                dropIdx === groupIdx && dragIdxRef.current !== null && dragIdxRef.current !== groupIdx;

              if (isSingle) {
                return (
                  <InvoiceOrderRow
                    key={group.orders[0].id}
                    order={group.orders[0]}
                    indented={false}
                    isDropTarget={isDropTarget}
                    isDragging={isDragging}
                    onDragStart={() => handleDragStart(groupIdx)}
                    onDragOver={(e) => handleDragOver(e, groupIdx)}
                    onDrop={() => handleDrop(groupIdx)}
                    onDragEnd={handleDragEnd}
                    {...orderRowContext}
                  />
                );
              }

              return (
                <InvoiceGroupRow
                  key={`group-${group.customerId}`}
                  group={group}
                  isExpanded={isExpanded}
                  isDropTarget={isDropTarget}
                  isDragging={isDragging}
                  onToggleExpand={toggleCustomer}
                  onDragStart={() => handleDragStart(groupIdx)}
                  onDragOver={(e) => handleDragOver(e, groupIdx)}
                  onDrop={() => handleDrop(groupIdx)}
                  onDragEnd={handleDragEnd}
                  {...orderRowContext}
                />
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
