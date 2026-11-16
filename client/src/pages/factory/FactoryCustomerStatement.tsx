import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, X } from "lucide-react";
import { CustomerStatementExports } from "./factorycustomerstatement/CustomerStatementExports";
import { PageHeader } from "@/components/PageHeader";
import { fmtMoney, fmtNum } from "./factorycustomerstatement/statementHelpers";
import { useFactoryCustomerStatementState } from "./useFactoryCustomerStatementState";
import { FactoryCustomerStatementSection } from "./FactoryCustomerStatementSection";
import { FactoryCustomerStatementSection2, FactoryCustomerStatementSection3 } from "./FactoryCustomerStatementSection2";

export default function FactoryCustomerStatement() {
  const {
    activeCustomerTab,
    addPriceDestination,
    customerId,
    deletePriceMutation,
    draftNote,
    fileInputRef,
    filterDateFrom,
    filterDateTo,
    filterDestination,
    filteredHistory,
    formatDisplayDate,
    handleExcelUpload,
    handlePriceListTemplateDownload,
    handleSavePrices,
    hasFilters,
    hasPriceEdits,
    isLoading,
    navigate,
    newCode,
    newDestination,
    newPrice,
    priceDestination,
    priceDestinationsQuery,
    priceEdits,
    priceListQuery,
    recordChanges,
    rowNotes,
    saveNoteMutation,
    savePricesMutation,
    saveRowNote,
    savingRowNote,
    selectPriceDestination,
    setDraftNote,
    setFilterDateFrom,
    setFilterDateTo,
    setFilterDestination,
    setNewCode,
    setNewDestination,
    setNewPrice,
    setPriceEdits,
    setRequestedCustomerTab,
    setRowNotes,
    showPriceListTab,
    showStatementTab,
    statement,
    totals,
  } = useFactoryCustomerStatementState();

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!statement) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <p className="text-muted-foreground" data-testid="text-not-found">
          Customer not found
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate("/factory/customers")}
          data-testid="button-back"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Customers
        </Button>
      </div>
    );
  }

  const { customer, currentBalance, currentBalanceSide, openingBalance, openingBalanceSide } = statement;
  const hasOpeningBalance = Number(openingBalance || 0) !== 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate("/factory/customers")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <PageHeader title={customer.legalName} />
            <Badge variant={customer.active ? "default" : "secondary"} data-testid="badge-customer-status">
              {customer.active ? "Active" : "Inactive"}
            </Badge>
          </div>
          {customer.phone && (
            <p className="text-muted-foreground text-sm mt-1" data-testid="text-customer-phone">
              {customer.phone}
            </p>
          )}
        </div>
        {showStatementTab && (
          <CustomerStatementExports
            customerId={customerId}
            filterDateFrom={filterDateFrom}
            filterDateTo={filterDateTo}
            filterDestination={filterDestination}
          />
        )}
      </div>

      {/* Balance cards */}
      {showStatementTab && (
        <div className={`grid grid-cols-1 gap-4 mb-6 ${hasOpeningBalance ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          <div className="rounded-xl border p-4">
            <p className="text-xs text-muted-foreground mb-1">Current Balance</p>
            <p className="text-2xl font-bold font-mono" data-testid="text-current-balance">
              {fmtMoney(currentBalance)}
            </p>
            <Badge variant="outline" className="mt-1 text-xs" data-testid="badge-balance-side">
              {currentBalanceSide}
            </Badge>
          </div>
          {hasOpeningBalance && (
            <div className="rounded-xl border p-4">
              <p className="text-xs text-muted-foreground mb-1">Opening Balance</p>
              <p className="text-xl font-semibold font-mono" data-testid="text-opening-balance">
                {fmtMoney(Number(openingBalance || 0))}
              </p>
              <Badge variant="outline" className="mt-1 text-xs">
                {openingBalanceSide}
              </Badge>
            </div>
          )}
          <div className="rounded-xl border p-4">
            <p className="text-xs text-muted-foreground mb-1">Total Invoices</p>
            <p className="text-2xl font-bold" data-testid="text-total-invoices">
              {statement.invoices.length}
            </p>
          </div>
        </div>
      )}

      {/* Tabs */}
      {activeCustomerTab ? (
        <Tabs
          value={activeCustomerTab}
          onValueChange={(value) => setRequestedCustomerTab(value as "statement" | "pricelist")}
          className="flex-1"
        >
          <div className="erp-mobile-scroll-tabs mb-4 pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Customer statement sections">
              {showStatementTab && (
                <TabsTrigger value="statement" data-testid="tab-statement">
                  Statement
                </TabsTrigger>
              )}
              {showPriceListTab && (
                <TabsTrigger value="pricelist" data-testid="tab-pricelist">
                  Price List
                  {(priceListQuery.data?.length ?? 0) > 0 && (
                    <Badge
                      variant="secondary"
                      className="ml-2 text-[11px] no-default-hover-elevate no-default-active-elevate"
                    >
                      {priceListQuery.data!.length}
                    </Badge>
                  )}
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          {/* ─── Statement Tab ─── */}
          {showStatementTab && (
            <TabsContent value="statement">
              {/* Filters */}
              <div className="flex flex-wrap items-end gap-3 mb-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground font-medium">Destination</label>
                  <Input
                    value={filterDestination}
                    onChange={(e) => setFilterDestination(e.target.value)}
                    placeholder="Filter by destination…"
                    className="w-48"
                    data-testid="input-filter-destination"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground font-medium">Date From</label>
                  <Input
                    type="date"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                    className="w-40"
                    data-testid="input-filter-date-from"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground font-medium">Date To</label>
                  <Input
                    type="date"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                    className="w-40"
                    data-testid="input-filter-date-to"
                  />
                </div>
                {hasFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFilterDestination("");
                      setFilterDateFrom("");
                      setFilterDateTo("");
                    }}
                    data-testid="button-clear-filters"
                  >
                    <X className="h-4 w-4 mr-1" />
                    Clear
                  </Button>
                )}
                <p className="text-xs text-muted-foreground ml-auto self-end">
                  {filteredHistory.length} of {statement.balanceHistory.length} rows
                </p>
              </div>

              {/* Totals bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Total Bales</p>
                  <p className="text-lg font-bold font-mono" data-testid="text-total-bales">
                    {fmtNum(totals.totalBales)}
                  </p>
                </div>
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Total Invoiced</p>
                  <p className="text-lg font-bold font-mono" data-testid="text-total-debit">
                    {fmtMoney(totals.totalAmountDebit)}
                  </p>
                </div>
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Total Paid</p>
                  <p className="text-lg font-bold font-mono" data-testid="text-total-credit">
                    {fmtMoney(totals.totalAmountCredit)}
                  </p>
                </div>
              </div>

              {/* Statement table */}
              <FactoryCustomerStatementSection3
                filteredHistory={filteredHistory}
                formatDisplayDate={formatDisplayDate}
                hasFilters={hasFilters}
                navigate={navigate}
                recordChanges={recordChanges}
                rowNotes={rowNotes}
                saveRowNote={saveRowNote}
                savingRowNote={savingRowNote}
                setRowNotes={setRowNotes}
              />

              {/* Statement Note */}
              <div className="rounded-xl border p-4 mt-4 space-y-2">
                <p className="text-sm font-semibold">Statement Note</p>
                <p className="text-xs text-muted-foreground">This note appears on exported PDF and Excel statements.</p>
                <Textarea
                  value={draftNote ?? ""}
                  onChange={(e) => setDraftNote(e.target.value)}
                  placeholder="Add a note for this customer's statement..."
                  rows={3}
                  readOnly={!recordChanges.allowed}
                  title={recordChanges.reason ?? undefined}
                  data-testid="textarea-statement-note"
                />
                {recordChanges.allowed && (
                  <Button
                    size="sm"
                    onClick={() => saveNoteMutation.mutate(draftNote ?? "")}
                    disabled={saveNoteMutation.isPending}
                    data-testid="button-save-statement-note"
                  >
                    {saveNoteMutation.isPending ? "Saving…" : "Save Note"}
                  </Button>
                )}
              </div>
            </TabsContent>
          )}

          {/* ─── Price List Tab ─── */}
          {showPriceListTab && (
            <TabsContent value="pricelist">
              <FactoryCustomerStatementSection2
                addPriceDestination={addPriceDestination}
                deletePriceMutation={deletePriceMutation}
                fileInputRef={fileInputRef}
                handleExcelUpload={handleExcelUpload}
                handlePriceListTemplateDownload={handlePriceListTemplateDownload}
                handleSavePrices={handleSavePrices}
                hasPriceEdits={hasPriceEdits}
                newDestination={newDestination}
                priceDestination={priceDestination}
                priceDestinationsQuery={priceDestinationsQuery}
                recordChanges={recordChanges}
                savePricesMutation={savePricesMutation}
                selectPriceDestination={selectPriceDestination}
                setNewDestination={setNewDestination}
              />

              <FactoryCustomerStatementSection
                deletePriceMutation={deletePriceMutation}
                handleSavePrices={handleSavePrices}
                newCode={newCode}
                newPrice={newPrice}
                priceDestination={priceDestination}
                priceDestinationsQuery={priceDestinationsQuery}
                priceEdits={priceEdits}
                priceListQuery={priceListQuery}
                recordChanges={recordChanges}
                savePricesMutation={savePricesMutation}
                setNewCode={setNewCode}
                setNewPrice={setNewPrice}
                setPriceEdits={setPriceEdits}
              />

              <p className="text-xs text-muted-foreground mt-3">
                Excel format: columns named <span className="font-mono">article_code</span> and{" "}
                <span className="font-mono">price</span> (or <span className="font-mono">price_per_bale</span>). Prices
                are saved only to the selected destination. Use "Save as Agreed Prices" on a proforma to store its
                prices here.
              </p>
            </TabsContent>
          )}
        </Tabs>
      ) : (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Customer Profile tabs are available for this user.
        </div>
      )}
    </div>
  );
}
