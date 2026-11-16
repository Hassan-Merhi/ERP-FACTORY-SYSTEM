import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { Redirect } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { Printer, AlertTriangle, FileSpreadsheet, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LabelPrintSettings } from "@/components/LabelPrintSettings";
import { formatLabelNum } from "@/lib/labelHtml";
import { useWipersReEntryState } from "./useWipersReEntryState";
import { WipersReEntryCardSection } from "./WipersReEntryCardSection";
import { WipersReEntryCardSection2, WipersReEntryCardSection3 } from "./WipersReEntryCardSection2";

export default function WipersReEntry() {
  const {
    activeLocations,
    addToCart,
    assignWorker,
    balesLoading,
    cart,
    cleanupMutation,
    cleanupOpen,
    cleanupSelectedIds,
    cleanupTotalKg,
    colors,
    confirmOpen,
    createdBales,
    currentWipersBales,
    designPickerOpen,
    entryDate,
    exportCsv,
    filteredProducts,
    handleKeyDown,
    handlePrint,
    handlePrintAll,
    navigate,
    openBrowserPrint,
    pendingLabels,
    productsLoading,
    removeItem,
    scanRef,
    searchError,
    searchInput,
    selectedLocationId,
    setCart,
    setCleanupOpen,
    setConfirmOpen,
    setDesignPickerOpen,
    setEntryDate,
    setPendingLabels,
    setQtyDirect,
    setSearchError,
    setSearchInput,
    setSelectedLocationId,
    setShowDropdown,
    setSupervisorPassword,
    setSupervisorUsername,
    showDropdown,
    showRelabeling,
    showWipersReEntry,
    stockEntryMutation,
    supervisorPassword,
    supervisorUsername,
    toast,
    toggleCleanupSelect,
    toggleSelectAll,
    totalKg,
    totalQty,
    updateQty,
    updateWeight,
    wiperProducts,
    workers,
  } = useWipersReEntryState();

  if (!showWipersReEntry && showRelabeling) {
    return <Redirect to="/factory/bale-relabeling" />;
  }
  if (!showWipersReEntry) {
    return (
      <div className="p-6 text-sm text-muted-foreground">No Bale Relabeling tabs are available for this user.</div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Sub-nav tabs */}
      <div className="erp-mobile-scroll-tabs px-3 pt-4 pb-1 sm:px-6">
        <TabsList aria-label="Bale relabeling sections" className="w-max min-w-full sm:min-w-0 sm:w-fit">
          {showRelabeling && (
            <PillTabButton
              selected={false}
              onClick={() => navigate("/factory/bale-relabeling")}
              data-testid="tab-relabeling"
            >
              Bale Relabeling
            </PillTabButton>
          )}
          <PillTabButton selected data-testid="tab-wipers-re-entry">
            Wipers Re-Entry by Date
          </PillTabButton>
        </TabsList>
      </div>

      <div className="p-6 space-y-6">
        {/* Header */}
        <div>
          <PageHeader
            title="Wipers Re-Entry by Date"
            subtitle="Create new wipers / garbage bales under a chosen entry date and print labels"
          />
        </div>

        {/* Controls */}
        <WipersReEntryCardSection3
          activeLocations={activeLocations}
          entryDate={entryDate}
          selectedLocationId={selectedLocationId}
          setCart={setCart}
          setEntryDate={setEntryDate}
          setSelectedLocationId={setSelectedLocationId}
          workers={workers}
        />

        {/* Cart */}
        <WipersReEntryCardSection
          addToCart={addToCart}
          assignWorker={assignWorker}
          cart={cart}
          entryDate={entryDate}
          filteredProducts={filteredProducts}
          handleKeyDown={handleKeyDown}
          productsLoading={productsLoading}
          removeItem={removeItem}
          scanRef={scanRef}
          searchError={searchError}
          searchInput={searchInput}
          selectedLocationId={selectedLocationId}
          setConfirmOpen={setConfirmOpen}
          setQtyDirect={setQtyDirect}
          setSearchError={setSearchError}
          setSearchInput={setSearchInput}
          setShowDropdown={setShowDropdown}
          showDropdown={showDropdown}
          toast={toast}
          totalKg={totalKg}
          totalQty={totalQty}
          updateQty={updateQty}
          updateWeight={updateWeight}
          wiperProducts={wiperProducts}
          workers={workers}
        />

        {/* Cleanup panel */}
        <WipersReEntryCardSection2
          balesLoading={balesLoading}
          cleanupMutation={cleanupMutation}
          cleanupOpen={cleanupOpen}
          cleanupSelectedIds={cleanupSelectedIds}
          cleanupTotalKg={cleanupTotalKg}
          currentWipersBales={currentWipersBales}
          setCleanupOpen={setCleanupOpen}
          setSupervisorPassword={setSupervisorPassword}
          setSupervisorUsername={setSupervisorUsername}
          supervisorPassword={supervisorPassword}
          supervisorUsername={supervisorUsername}
          toggleCleanupSelect={toggleCleanupSelect}
          toggleSelectAll={toggleSelectAll}
        />

        {/* Results section */}
        {createdBales && createdBales.length > 0 && (
          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-primary">
                <Tag className="h-4 w-4" />
                Bales Created Successfully
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-1">Bales Created</p>
                  <p className="text-2xl font-bold font-mono" data-testid="text-result-qty">
                    {createdBales.length}
                  </p>
                </div>
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-1">Entry Date</p>
                  <p className="text-lg font-semibold" data-testid="text-result-date">
                    {entryDate}
                  </p>
                </div>
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-1">Total Weight</p>
                  <p className="text-lg font-bold font-mono" data-testid="text-result-weight">
                    {formatLabelNum(createdBales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0))} kg
                  </p>
                </div>
              </div>

              {/* Print buttons */}
              <LabelPrintSettings />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => handlePrint("A4")} variant="outline" data-testid="button-print-a4">
                  <Printer className="h-4 w-4 mr-2" />
                  Print A4
                </Button>
                <Button onClick={() => handlePrint("sticker")} variant="outline" data-testid="button-print-sticker">
                  <Printer className="h-4 w-4 mr-2" />
                  Print Sticker
                </Button>
                <Button onClick={() => handlePrint("A5")} variant="outline" data-testid="button-print-a5">
                  <Printer className="h-4 w-4 mr-2" />
                  Print A5
                </Button>
                <Button onClick={handlePrintAll} data-testid="button-print-all">
                  <Printer className="h-4 w-4 mr-2" />
                  Print All Formats
                </Button>
                <Button variant="outline" onClick={exportCsv} data-testid="button-export-csv">
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                  Export CSV
                </Button>
              </div>

              {/* Preview of first few labels */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Generated References</p>
                <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                  {createdBales.map((b) => (
                    <Badge
                      key={b.id}
                      variant="secondary"
                      className="font-mono text-xs"
                      data-testid={`badge-ref-${b.id}`}
                    >
                      {b.referenceNumber}
                    </Badge>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Confirm dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirm Wipers Re-Entry</DialogTitle>
            <DialogDescription>Review details before creating bales</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground">Entry Date</span>
              <span className="font-semibold text-primary" data-testid="text-confirm-date">
                {entryDate}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground">Location</span>
              <span className="font-semibold" data-testid="text-confirm-location">
                {activeLocations.find((l) => l.id.toString() === selectedLocationId)?.name || "-"}
              </span>
            </div>
            <div className="table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Weight/Bale</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cart.map((item) => (
                    <TableRow key={item.productId}>
                      <TableCell className="text-xs">{item.product.name}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{item.qty}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{item.weightPerBaleKg} kg</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatLabelNum(item.qty * item.weightPerBaleKg)} kg
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex justify-between rounded-md border px-3 py-2 font-semibold">
              <span>Total: {totalQty} bales</span>
              <span>{formatLabelNum(totalKg)} kg</span>
            </div>
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 space-y-1">
              <p className="flex items-center gap-1 font-medium">
                <AlertTriangle className="h-3 w-3" /> Important
              </p>
              <p>
                Bales will be recorded under <strong>{entryDate}</strong>, not today's date.
              </p>
              <p>New reference numbers continue from the existing REF sequence.</p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)} data-testid="button-confirm-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => stockEntryMutation.mutate()}
              disabled={stockEntryMutation.isPending}
              data-testid="button-confirm-submit"
            >
              {stockEntryMutation.isPending ? "Creating..." : `Create ${totalQty} Bales`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A4 Design color picker */}
      <Dialog open={designPickerOpen} onOpenChange={setDesignPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose A4 Label Design</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            {colors.map((opt) => (
              <Button
                key={opt.value}
                variant="outline"
                onClick={() => {
                  setDesignPickerOpen(false);
                  if (pendingLabels) openBrowserPrint(pendingLabels, "A4", opt.value);
                  setPendingLabels(null);
                }}
                data-testid={`button-design-${opt.value}`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full mr-2 shrink-0 border border-border/50"
                  style={{ background: opt.color }}
                />
                {opt.label}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
