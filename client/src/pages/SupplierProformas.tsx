import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2, Upload, Download, FileText, Pencil, Save, X } from "lucide-react";
import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { PageHeader } from "@/components/PageHeader";
import { calculateLineTotal, parseFiniteNumber } from "./SupplierProformasTypes";
import { useSupplierProformasState } from "./useSupplierProformasState";
import { SupplierProformasSection, SupplierProformasTableRowSection } from "./SupplierProformasSection";

export default function SupplierProformas() {
  const {
    addLineMutation,
    addingLine,
    commitRename,
    createMutation,
    createNotes,
    createRef,
    deleteLineMutation,
    deleteMutation,
    downloadTemplate,
    editLineData,
    editingLineId,
    fileInputRef,
    handleBack,
    handleFileImport,
    isLoading,
    newLine,
    pendingDelete,
    proformas,
    recordChanges,
    renameInputRef,
    renameValue,
    renamingId,
    selectedProforma,
    selectedProformaId,
    setAddingLine,
    setCreateNotes,
    setCreateRef,
    setEditLineData,
    setEditingLineId,
    setImportTarget,
    setNewLine,
    setPendingDelete,
    setRenameValue,
    setRenamingId,
    setSelectedProformaId,
    setShowCreateDialog,
    showCreateDialog,
    starMutation,
    startEdit,
    startRename,
    supplierId,
    updateLineMutation,
  } = useSupplierProformasState();

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-10 w-64 mb-4" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const lines = selectedProforma?.lines || [];
  const totalQty = lines.reduce((total, line) => total + parseFiniteNumber(line.qty), 0);
  const totalAmount = lines.reduce((total, line) => total + calculateLineTotal(line.qty, line.pricePerBale), 0);

  return (
    <div className="flex flex-col h-full overflow-y-auto sm:p-4 lg:p-6">
      <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleFileImport} />

      <PageHeader
        title="Supplier Proformas"
        onBack={handleBack}
        meta={<span>Manage proformas for supplier #{supplierId}</span>}
      >
        <Button variant="outline" onClick={downloadTemplate} data-testid="button-download-template">
          <Download className="mr-2 h-4 w-4" />
          Template
        </Button>
        {recordChanges.allowed && (
          <Button onClick={() => setShowCreateDialog(true)} data-testid="button-create-proforma">
            <Plus className="mr-2 h-4 w-4" />
            New Proforma
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SupplierProformasSection
          commitRename={commitRename}
          deleteMutation={deleteMutation}
          proformas={proformas}
          recordChanges={recordChanges}
          renameInputRef={renameInputRef}
          renameValue={renameValue}
          renamingId={renamingId}
          selectedProformaId={selectedProformaId}
          setPendingDelete={setPendingDelete}
          setRenameValue={setRenameValue}
          setRenamingId={setRenamingId}
          setSelectedProformaId={setSelectedProformaId}
          starMutation={starMutation}
          startRename={startRename}
        />

        <div className="lg:col-span-2">
          {selectedProformaId && selectedProforma ? (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-lg">{selectedProforma.reference}</CardTitle>
                  {selectedProforma.notes && (
                    <p className="text-xs text-muted-foreground mt-1">{selectedProforma.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{lines.length} items</Badge>
                  {recordChanges.allowed && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setImportTarget(selectedProformaId);
                        fileInputRef.current?.click();
                      }}
                      data-testid="button-import-lines"
                    >
                      <Upload className="mr-1 h-3 w-3" />
                      Import Excel
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      window.location.href = `/api/suppliers/${supplierId}/proformas/${selectedProformaId}/export-excel`;
                    }}
                    data-testid="button-export-excel"
                  >
                    <Download className="mr-1 h-3 w-3" />
                    Export Excel
                  </Button>
                  {recordChanges.allowed && (
                    <Button size="sm" onClick={() => setAddingLine(true)} data-testid="button-add-line">
                      <Plus className="mr-1 h-3 w-3" />
                      Add Line
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Barcode</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price/Bale</TableHead>
                      <TableHead className="text-right">Total Amount</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {addingLine && (
                      <SupplierProformasTableRowSection
                        addLineMutation={addLineMutation}
                        newLine={newLine}
                        setAddingLine={setAddingLine}
                        setNewLine={setNewLine}
                      />
                    )}
                    {lines.map((line) => (
                      <TableRow key={line.id} data-testid={`row-line-${line.id}`}>
                        {editingLineId === line.id ? (
                          <>
                            <TableCell>
                              <Input
                                value={editLineData.barcode}
                                onChange={(e) => setEditLineData({ ...editLineData, barcode: e.target.value })}
                                className="h-8 text-xs"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                value={editLineData.itemName}
                                onChange={(e) => setEditLineData({ ...editLineData, itemName: e.target.value })}
                                className="h-8 text-xs"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                value={editLineData.qty}
                                onChange={(e) => setEditLineData({ ...editLineData, qty: e.target.value })}
                                className="h-8 text-xs w-16 text-right"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                step="0.01"
                                value={editLineData.pricePerBale}
                                onChange={(e) => setEditLineData({ ...editLineData, pricePerBale: e.target.value })}
                                className="h-8 text-xs w-20 text-right"
                              />
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {calculateLineTotal(editLineData.qty, editLineData.pricePerBale).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => updateLineMutation.mutate({ id: line.id, data: editLineData })}
                                >
                                  <Save className="h-3 w-3" />
                                </Button>
                                <Button size="icon" variant="ghost" onClick={() => setEditingLineId(null)}>
                                  <X className="h-3 w-3" />
                                </Button>
                              </div>
                            </TableCell>
                          </>
                        ) : (
                          <>
                            <TableCell className="font-mono text-xs">{line.barcode}</TableCell>
                            <TableCell className="text-sm">{line.itemName}</TableCell>
                            <TableCell className="text-right font-mono">{line.qty}</TableCell>
                            <TableCell className="text-right font-mono">
                              {parseFloat(line.pricePerBale).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {calculateLineTotal(line.qty, line.pricePerBale).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right">
                              {recordChanges.allowed && (
                                <div className="flex items-center justify-end gap-1">
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => startEdit(line)}
                                    data-testid={`button-edit-line-${line.id}`}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => setPendingDelete(() => () => deleteLineMutation.mutate(line.id))}
                                    data-testid={`button-delete-line-${line.id}`}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </TableCell>
                          </>
                        )}
                      </TableRow>
                    ))}
                    {lines.length === 0 && !addingLine && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground text-sm py-8">
                          No lines yet. Add lines manually or import from Excel.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                  {lines.length > 0 && (
                    <TableFooter>
                      <TableRow data-testid="row-proforma-totals">
                        <TableCell colSpan={2} className="font-semibold">
                          Total
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold" data-testid="total-proforma-qty">
                          {totalQty}
                        </TableCell>
                        <TableCell />
                        <TableCell className="text-right font-mono font-semibold" data-testid="total-proforma-amount">
                          {totalAmount.toFixed(2)}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex items-center justify-center py-16">
                <div className="text-center text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">Select a proforma from the list or create a new one</p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        onConfirm={() => {
          pendingDelete?.();
          setPendingDelete(null);
        }}
      />

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Proforma</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Reference *</label>
              <Input
                value={createRef}
                onChange={(e) => setCreateRef(e.target.value)}
                placeholder="e.g. PF-2026-001"
                data-testid="input-proforma-ref"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Notes</label>
              <Textarea
                value={createNotes}
                onChange={(e) => setCreateNotes(e.target.value)}
                placeholder="Optional notes..."
                data-testid="input-proforma-notes"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => createMutation.mutate({ reference: createRef, notes: createNotes })}
                disabled={!createRef.trim() || createMutation.isPending}
                data-testid="button-confirm-create"
              >
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
