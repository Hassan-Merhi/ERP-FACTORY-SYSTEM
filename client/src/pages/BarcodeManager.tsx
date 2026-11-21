import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Checkbox } from "@/components/ui/checkbox";
import { Printer, Trash2, Barcode, Check, FileSpreadsheet } from "lucide-react";
import { useBarcodeManagerState } from "./useBarcodeManagerState";

export default function BarcodeManager() {
  const {
    selectedCompany,
    formatDisplayDate,
    fileInputRef,
    selectedIds,
    setSelectedIds,
    manualBarcode,
    setManualBarcode,
    isLoading,
    isError,
    barcodes,
    refetch,
    deleteBarcode,
    handleFileUpload,
    handlePrint,
    handleSelectAll,
    handleSelectOne,
    handleManualAdd,
    unusedBarcodes,
    usedBarcodes,
  } = useBarcodeManagerState();

  if (!selectedCompany) {
    return (
      <div className="container mx-auto p-6">
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">Please select a company to manage barcodes</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-4 p-0 sm:p-4 md:space-y-6 md:p-6">
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileUpload} />
      <PageHeader
        title="Barcode Manager"
        subtitle="Import, print, and manage barcode labels for bales"
        icon={<Barcode className="h-5 w-5" />}
      >
        <Button variant="outline" onClick={() => fileInputRef.current?.click()} data-testid="button-upload">
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Import Excel
        </Button>
        <Button onClick={handlePrint} disabled={unusedBarcodes.length === 0} data-testid="button-print">
          <Printer className="h-4 w-4 mr-2" />
          Print Labels {selectedIds.length > 0 ? `(${selectedIds.length})` : ""}
        </Button>
      </PageHeader>

      <Card className="p-4 md:p-6">
        <h2 className="text-lg font-semibold mb-4">Add Barcode Manually</h2>
        <form onSubmit={handleManualAdd} className="flex flex-col sm:flex-row gap-2" noValidate>
          <Input
            placeholder="Enter barcode..."
            value={manualBarcode}
            onChange={(e) => setManualBarcode(e.target.value)}
            className="sm:max-w-md font-mono"
            data-testid="input-manual-barcode"
          />
          <Button type="submit" disabled={!manualBarcode.trim()} data-testid="button-add-barcode">
            Add
          </Button>
        </form>
      </Card>

      <Card className="p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 className="text-lg font-semibold">Pending Barcodes ({unusedBarcodes.length})</h2>
          {selectedIds.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                selectedIds.forEach((id) => deleteBarcode.mutate(id));
                setSelectedIds([]);
              }}
              data-testid="button-delete-selected"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Selected ({selectedIds.length})
            </Button>
          )}
        </div>

        {isLoading ? (
          <LoadingState />
        ) : isError && barcodes.length === 0 ? (
          <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="py-12" />
        ) : unusedBarcodes.length === 0 ? (
          <EmptyState
            icon={Barcode}
            title="No pending barcodes. Import from Excel or add manually."
            className="py-12"
          />
        ) : (
          <>
            <div className="hidden md:block phone-land:hidden">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox
                        checked={selectedIds.length === unusedBarcodes.length && unusedBarcodes.length > 0}
                        onCheckedChange={(checked) => handleSelectAll(checked === true)}
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unusedBarcodes.map((barcode) => (
                    <TableRow key={barcode.id} data-testid={`row-barcode-${barcode.id}`}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.includes(barcode.id)}
                          onCheckedChange={(checked) => handleSelectOne(barcode.id, !!checked)}
                        />
                      </TableCell>
                      <TableCell className="font-mono font-medium">{barcode.barcode}</TableCell>
                      <TableCell>
                        {barcode.printed ? (
                          <Badge variant="secondary">
                            <Check className="h-3 w-3 mr-1" />
                            Printed
                          </Badge>
                        ) : (
                          <Badge variant="outline">Not Printed</Badge>
                        )}
                      </TableCell>
                      <TableCell>{formatDisplayDate(barcode.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteBarcode.mutate(barcode.id)}
                          data-testid={`button-delete-${barcode.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="md:hidden phone-land:block space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <Checkbox
                  checked={selectedIds.length === unusedBarcodes.length && unusedBarcodes.length > 0}
                  onCheckedChange={(checked) => handleSelectAll(checked === true)}
                />
                <span className="text-sm text-muted-foreground">Select All</span>
              </div>
              {unusedBarcodes.map((barcode) => (
                <Card key={barcode.id} className="p-3" data-testid={`card-barcode-${barcode.id}`}>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedIds.includes(barcode.id)}
                      onCheckedChange={(checked) => handleSelectOne(barcode.id, !!checked)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium text-sm">{barcode.barcode}</span>
                        <Button variant="ghost" size="icon" onClick={() => deleteBarcode.mutate(barcode.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {barcode.printed ? (
                          <Badge variant="secondary">
                            <Check className="h-3 w-3 mr-1" />
                            Printed
                          </Badge>
                        ) : (
                          <Badge variant="outline">Not Printed</Badge>
                        )}
                        <span className="text-xs text-muted-foreground">{formatDisplayDate(barcode.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </Card>

      {usedBarcodes.length > 0 && (
        <Card className="p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">Used Barcodes ({usedBarcodes.length})</h2>
          <p className="text-sm text-muted-foreground mb-4">These barcodes have been scanned and added to inventory</p>
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Barcode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usedBarcodes.slice(0, 10).map((barcode) => (
                <TableRow key={barcode.id}>
                  <TableCell className="font-mono">{barcode.barcode}</TableCell>
                  <TableCell>
                    <Badge variant="default">
                      <Check className="h-3 w-3 mr-1" />
                      In Inventory
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDisplayDate(barcode.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {usedBarcodes.length > 10 && (
            <p className="text-sm text-muted-foreground mt-4">Showing 10 of {usedBarcodes.length} used barcodes</p>
          )}
        </Card>
      )}
    </div>
  );
}
