import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  DollarSign,
  FileText,
  Truck,
  Trash2,
  HandCoins,
  Calendar,
  User,
  RotateCcw,
  Edit,
  Download,
  Printer,
  Upload,
  ChevronDown,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OffloadDialog } from "@/components/OffloadDialog";
import { ContainerDetailDialog1 } from "./ContainerDetailDialog1";
import type { ContainerPriceImportPreviewRow, useContainerDetailModel } from "../useContainerDetailModel";

type Model = ReturnType<typeof useContainerDetailModel>;
export function ContainerDetailErpView({ model }: { model: Model }) {
  // prettier-ignore
  const { formatDisplayDate, containerId, showOffloadDialog, setShowOffloadDialog, showSellDialog, setShowSellDialog, pendingDelete, setPendingDelete, setLocation, formatAmount, isSupplierPartner: _isSupplierPartner, isDeveloper, containerData, suppliers, customers, incomeAccounts, containerSale, docsData, showUploadDialog, setShowUploadDialog, showFreightDialog, setShowFreightDialog, uploadDocTypeId, setUploadDocTypeId, uploadFile, setUploadFile, fileInputRef, showPriceImportDialog, setShowPriceImportDialog, priceImportPreview, setPriceImportPreview, priceImportParsing, priceImportError, setPriceImportError, priceImportFileRef, pricePreviewMutation, priceApplyMutation, handlePriceImportFile, uploadDocMutation, freightForm, addFreightMutation, handleExportContainer, handleExportContainerNoCost, backUrl, form, deletePOMutation, deleteContainerMutation, syncVoucherMutation, reverseOffloadMutation, sellContainerMutation, handleDeletePO, handleDeleteContainer, handleSellSubmit, handlePrint, saleCustomer } = model;
  // Defensive guard: by this point isSupplierPartner is false (handled above) and the
  // earlier `!containerData && !isSupplierPartner` check already returned if missing,
  // but TS can't infer that across the two branches — this re-confirms it for display only.
  if (!containerData) return null;

  const { container, pos, charges } = containerData;
  const supplier = suppliers.find((s) => s.id === container.supplierId);

  // Compute totals live from the actual PO and charges data so they are
  // always accurate, even when the stored container totals are stale.
  const itemsTotal = pos.reduce((sum: number, po) => sum + parseFloat(po.itemsTotal || "0"), 0);
  const chargesTotal = charges.reduce((sum: number, c) => sum + parseFloat(c.amount || "0"), 0);
  const grandTotal = itemsTotal + chargesTotal;

  // Calculate total bales from all line items
  const totalBales = pos.reduce((total: number, po) => {
    return (
      total +
      po.items.reduce((sum, item) => {
        return sum + parseFloat(item.quantity || "0");
      }, 0)
    );
  }, 0);

  // Format quantity: strip trailing zeros (e.g. "7.000" → "7", "2.500" → "2.5")
  const fmtQty = (q: string | number | null | undefined) => {
    const n = parseFloat(String(q ?? "0"));
    if (isNaN(n)) return "0";
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  };

  return (
    <div className="space-y-5 p-3 sm:p-0">
      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={backUrl}>
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold truncate" data-testid="text-container-number">
                Container {container.containerNumber}
              </h1>
              <Badge
                variant={
                  container.status === "OTW" ? "default" : container.status === "OFFLOADED" ? "secondary" : "outline"
                }
                className="shrink-0"
                data-testid="badge-status"
              >
                {container.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              Imported on {formatDisplayDate(container.importDate)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* View Offload button — only shown on offloaded containers */}
          {container.status === "OFFLOADED" && containerData?.offloadId && (
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => setLocation(`/offloads/${containerData.offloadId}`)}
              data-testid="button-view-offload"
            >
              <ExternalLink className="w-4 h-4" />
              View Offload
            </Button>
          )}
          {/* Actions dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2" data-testid="button-actions-dropdown">
                Actions
                <ChevronDown className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {isDeveloper && (
                <>
                  <DropdownMenuItem
                    onClick={() => syncVoucherMutation.mutate()}
                    disabled={syncVoucherMutation.isPending}
                    data-testid="button-sync-voucher"
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    {syncVoucherMutation.isPending ? "Syncing..." : "Sync Supplier Balance"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onClick={() => setLocation(`/containers/${containerId}/verification`)}
                data-testid="button-verify-container"
              >
                <FileText className="w-4 h-4 mr-2" />
                Verify
              </DropdownMenuItem>
              {!containerSale && (
                <DropdownMenuItem onClick={() => setShowSellDialog(true)} data-testid="button-sell-container">
                  <HandCoins className="w-4 h-4 mr-2" />
                  Sell Container
                </DropdownMenuItem>
              )}
              {container.status !== "OFFLOADED" && (
                <DropdownMenuItem onClick={() => setShowOffloadDialog(true)} data-testid="button-offload-container">
                  <Truck className="w-4 h-4 mr-2" />
                  Offload Container
                </DropdownMenuItem>
              )}
              {container.status === "OFFLOADED" && (
                <>
                  <DropdownMenuItem onClick={() => setShowOffloadDialog(true)} data-testid="button-edit-offload">
                    <Edit className="w-4 h-4 mr-2" />
                    Edit Offload
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setPendingDelete(() => () => reverseOffloadMutation.mutate(parseInt(containerId!)))}
                    disabled={reverseOffloadMutation.isPending}
                    data-testid="button-reverse-offload"
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Reverse Offload
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Export dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2" data-testid="button-export-dropdown">
                <Download className="w-4 h-4" />
                Export
                <ChevronDown className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={handleExportContainer} data-testid="button-export-excel">
                <Download className="w-4 h-4 mr-2" />
                Full Export
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportContainerNoCost} data-testid="button-export-no-cost">
                <Download className="w-4 h-4 mr-2" />
                No Cost / Freight Export
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handlePrint} data-testid="button-export-pdf">
                <Printer className="w-4 h-4 mr-2" />
                Export PDF
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setPriceImportPreview(null);
                  setPriceImportError(null);
                  setShowPriceImportDialog(true);
                }}
                data-testid="button-import-pricing"
              >
                <Upload className="w-4 h-4 mr-2" />
                Import Pricing (Excel)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="destructive"
            onClick={handleDeleteContainer}
            disabled={deleteContainerMutation.isPending}
            className="gap-2"
            data-testid="button-delete-container"
          >
            <Trash2 className="w-4 h-4" />
            <span className="hidden sm:inline">Delete Container</span>
            <span className="sm:hidden">Delete</span>
          </Button>
        </div>
      </div>

      {containerSale && (
        <Card className="border-green-500">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HandCoins className="h-5 w-5 text-green-600" />
              Container Sold
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Sold to</p>
                <p className="font-semibold" data-testid="text-sale-customer">
                  {saleCustomer?.legalName || "Unknown Customer"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Sale Date</p>
                <p className="font-semibold" data-testid="text-sale-date">
                  {formatDisplayDate(containerSale.saleDate)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Sale Price</p>
                <p className="font-semibold" data-testid="text-sale-price">
                  {formatAmount(containerSale.containerCost)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Commission</p>
                <p className="font-semibold" data-testid="text-sale-commission">
                  {formatAmount(containerSale.commission)}
                </p>
              </div>
            </div>
            <div className="pt-2 border-t">
              <p className="text-sm text-muted-foreground">Total Amount</p>
              <p className="text-xl font-bold" data-testid="text-sale-total">
                {formatAmount(containerSale.totalAmount)}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Supplier</p>
          <p className="text-base font-semibold leading-tight" data-testid="text-supplier">
            {supplier ? supplier.legalName : "—"}
          </p>
          {supplier && <p className="text-xs text-muted-foreground">{supplier.code}</p>}
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Items Total</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="text-items-total">
            {formatAmount(itemsTotal)}
          </p>
          <p className="text-xs text-muted-foreground">
            {pos.reduce((sum: number, po) => sum + po.items.length, 0)} items in {pos.length} PO(s)
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Grand Total</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="text-grand-total">
            {formatAmount(grandTotal)}
          </p>
          {chargesTotal > 0 && (
            <p className="text-xs text-muted-foreground">Including {formatAmount(Math.abs(chargesTotal))} in charges</p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-0.5">Purchase Orders</h2>
      </div>
      {pos.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No purchase orders found
        </div>
      ) : (
        <div className="space-y-4">
          {pos.map((po) => (
            <div key={po.id} className="rounded-lg border bg-card overflow-hidden">
              {/* PO header bar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 bg-muted/40 border-b">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-sm" data-testid={`text-po-${po.poNumber}`}>
                    {po.poNumber}
                  </span>
                  <span className="text-xs text-muted-foreground">{po.currency}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold tabular-nums">{formatAmount(po.itemsTotal)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setLocation(`/purchase-orders/${po.id}/edit`)}
                    data-testid={`button-edit-po-${po.id}`}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeletePO(po.id, po.poNumber)}
                    disabled={deletePOMutation.isPending}
                    data-testid={`button-delete-po-${po.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Items table — desktop */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Item Name
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Qty
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Rate
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Total
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {po.items.map((item) => (
                      <TableRow key={item.id} data-testid={`row-item-${item.id}`} className="text-sm">
                        <TableCell className="font-medium py-2">{item.itemName}</TableCell>
                        <TableCell className="text-right tabular-nums py-2 text-muted-foreground">
                          {fmtQty(item.quantity)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums py-2 text-muted-foreground">
                          {formatAmount(item.rate)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums py-2 font-semibold">
                          {formatAmount(item.lineTotal)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Items — mobile */}
              <div className="md:hidden divide-y">
                {po.items.map((item) => (
                  <div key={item.id} className="px-4 py-3 text-sm" data-testid={`row-item-${item.id}`}>
                    <p className="font-medium mb-1.5">{item.itemName}</p>
                    <div className="grid grid-cols-3 gap-2 text-muted-foreground text-xs">
                      <div>
                        <span className="block">Qty</span>
                        <span className="font-mono font-medium text-foreground">{fmtQty(item.quantity)}</span>
                      </div>
                      <div>
                        <span className="block">Rate</span>
                        <span className="font-mono font-medium text-foreground">{formatAmount(item.rate)}</span>
                      </div>
                      <div>
                        <span className="block">Total</span>
                        <span className="font-mono font-semibold text-foreground">{formatAmount(item.lineTotal)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {charges.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <div className="px-4 py-3 bg-muted/40 border-b">
            <p className="text-sm font-semibold">Extra Charges</p>
          </div>
          <table className="w-full text-sm min-w-[360px]">
            <thead>
              <tr className="border-b">
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Misc Type
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c, i: number) => (
                <tr key={i} className="border-t first:border-t-0">
                  <td className="px-4 py-2.5 text-muted-foreground">{c.chargeType}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                    {formatAmount(parseFloat(c.amount || "0"))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/20">
                <td className="px-4 py-2.5 font-semibold">Total Charges</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{formatAmount(chargesTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="rounded-lg border bg-card p-4 space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Summary</p>
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Items Total</span>
            <span className="tabular-nums font-medium">{formatAmount(itemsTotal)}</span>
          </div>
          {chargesTotal !== 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Charges Total</span>
              <span className="tabular-nums font-medium">{formatAmount(chargesTotal)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total Qty</span>
            <span className="tabular-nums font-medium">{fmtQty(totalBales)}</span>
          </div>
          <div className="flex justify-between pt-2 border-t font-bold">
            <span>Grand Total</span>
            <span className="tabular-nums text-base">{formatAmount(grandTotal)}</span>
          </div>
        </div>
      </div>

      <OffloadDialog
        open={showOffloadDialog}
        onOpenChange={setShowOffloadDialog}
        containerId={parseInt(containerId!)}
        containerNumber={container.containerNumber}
        totalBales={totalBales}
      />

      <Dialog open={showSellDialog} onOpenChange={setShowSellDialog}>
        <DialogContent data-testid="dialog-sell-container">
          <DialogHeader>
            <DialogTitle>Sell Container</DialogTitle>
            <DialogDescription>
              Record the sale of container {container.containerNumber} to a customer.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form noValidate onSubmit={form.handleSubmit(handleSellSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Customer</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-customer">
                          <SelectValue placeholder="Select a customer" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {customers.map((customer) => (
                          <SelectItem key={customer.id} value={customer.id.toString()}>
                            {customer.legalName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="saleDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sale Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} data-testid="input-sale-date" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="rounded-md border p-4 bg-muted/50">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium">Container Cost</span>
                  <span className="text-lg font-bold">{formatAmount(grandTotal)}</span>
                </div>
                <p className="text-xs text-muted-foreground">Full balance will be charged to customer</p>
              </div>

              <FormField
                control={form.control}
                name="commission"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Commission</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-commission" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="commissionAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Commission Account (Optional)</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-commission-account">
                          <SelectValue placeholder="Default commission account" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {incomeAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id.toString()}>
                            {account.name} ({account.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Leave empty to use default commission revenue account
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowSellDialog(false)}
                  data-testid="button-cancel-sale"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={sellContainerMutation.isPending} data-testid="button-submit-sale">
                  {sellContainerMutation.isPending ? "Processing..." : "Record Sale"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent data-testid="dialog-upload-doc">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>Upload a document for this container</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Document Type</label>
              <Select value={uploadDocTypeId} onValueChange={setUploadDocTypeId}>
                <SelectTrigger data-testid="select-doc-type">
                  <SelectValue placeholder="Select document type" />
                </SelectTrigger>
                <SelectContent>
                  {(docsData?.docTypes || []).map((dt) => (
                    <SelectItem key={dt.id} value={String(dt.id)}>
                      {dt.label}
                      {dt.isRequired ? " *" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">File</label>
              <Input
                type="file"
                ref={fileInputRef}
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                data-testid="input-doc-file"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowUploadDialog(false)} data-testid="button-cancel-upload">
                Cancel
              </Button>
              <Button
                disabled={!uploadDocTypeId || !uploadFile || uploadDocMutation.isPending}
                onClick={() => uploadDocMutation.mutate({ docTypeId: Number(uploadDocTypeId), file: uploadFile! })}
                data-testid="button-submit-upload"
              >
                {uploadDocMutation.isPending ? "Uploading..." : "Upload"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showFreightDialog} onOpenChange={setShowFreightDialog}>
        <DialogContent data-testid="dialog-add-freight">
          <DialogHeader>
            <DialogTitle>Add Freight Charge</DialogTitle>
            <DialogDescription>Record a freight/shipping charge for this container</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            onSubmit={freightForm.handleSubmit((data) => addFreightMutation.mutate(data))}
            className="space-y-4"
          >
            <div>
              <label className="text-sm font-medium">Vendor Name</label>
              <Input
                {...freightForm.register("vendorName")}
                placeholder="Shipping company"
                data-testid="input-freight-vendor"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-sm font-medium">Amount</label>
                <Input
                  {...freightForm.register("freightAmount")}
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  data-testid="input-freight-amount"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Currency</label>
                <Select
                  value={freightForm.watch("currency")}
                  onValueChange={(v) => freightForm.setValue("currency", v)}
                >
                  <SelectTrigger data-testid="select-freight-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="XOF">XOF (CFA)</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">Due Date (optional)</label>
              <Input {...freightForm.register("dueDate")} type="date" data-testid="input-freight-due" />
            </div>
            <div>
              <label className="text-sm font-medium">Notes (optional)</label>
              <Textarea
                {...freightForm.register("notes")}
                placeholder="Additional details"
                data-testid="input-freight-notes"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowFreightDialog(false)}
                data-testid="button-cancel-freight"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={addFreightMutation.isPending} data-testid="button-submit-freight">
                {addFreightMutation.isPending ? "Adding..." : "Add Freight"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ContainerDetailDialog1 model={model} />
      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          pendingDelete?.();
          setPendingDelete(null);
        }}
      />

      {/* Price Import Dialog */}
      <Dialog
        open={showPriceImportDialog}
        onOpenChange={(open) => {
          if (!open) {
            setPriceImportPreview(null);
            setPriceImportError(null);
          }
          setShowPriceImportDialog(open);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Import Pricing from Excel</DialogTitle>
            <DialogDescription>
              Upload an Excel file with columns <strong>barcode</strong> and <strong>price</strong>. Review the preview,
              then save to apply.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 flex-1 overflow-hidden">
            {/* File upload area */}
            <div
              className="border-2 border-dashed rounded-md p-6 flex flex-col items-center gap-3 cursor-pointer hover-elevate"
              onClick={() => priceImportFileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) handlePriceImportFile(file);
              }}
              data-testid="dropzone-price-import"
            >
              <Upload className="w-8 h-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground text-center">
                Click or drag an Excel file here
                <br />
                <span className="text-xs">
                  Columns: <code>barcode</code> and <code>price</code> (or A/B if no headers)
                </span>
              </p>
              <input
                ref={priceImportFileRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                data-testid="input-price-import-file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handlePriceImportFile(file);
                  e.target.value = "";
                }}
              />
            </div>

            {(priceImportParsing || pricePreviewMutation.isPending) && (
              <p className="text-sm text-muted-foreground text-center">Reading file and fetching preview…</p>
            )}

            {priceImportError && <p className="text-sm text-destructive">{priceImportError}</p>}

            {/* Preview table */}
            {priceImportPreview && priceImportPreview.length > 0 && (
              <div className="overflow-auto flex-1 border rounded-md">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Code / Barcode</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Current Rate</TableHead>
                      <TableHead>New Rate</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {priceImportPreview.map((row, i: number) => (
                      <TableRow key={i} data-testid={`row-price-preview-${i}`}>
                        <TableCell className="font-mono text-xs">{row.barcode}</TableCell>
                        <TableCell className="text-sm">{row.itemName || "—"}</TableCell>
                        <TableCell className="text-sm">
                          {row.currentRate != null ? formatAmount(row.currentRate) : "—"}
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          {row.newRate != null ? formatAmount(row.newRate) : "—"}
                        </TableCell>
                        <TableCell>
                          {row.status === "will_update" && (
                            <Badge variant="default" data-testid={`status-preview-${i}`}>
                              Will Update
                            </Badge>
                          )}
                          {row.status === "no_change" && (
                            <Badge variant="secondary" data-testid={`status-preview-${i}`}>
                              No Change
                            </Badge>
                          )}
                          {row.status === "not_found" && (
                            <Badge variant="destructive" data-testid={`status-preview-${i}`}>
                              Not Found
                            </Badge>
                          )}
                          {row.status === "not_in_container" && (
                            <Badge variant="secondary" data-testid={`status-preview-${i}`}>
                              Not in Container
                            </Badge>
                          )}
                          {row.status === "invalid_price" && (
                            <Badge variant="destructive" data-testid={`status-preview-${i}`}>
                              Invalid Price
                            </Badge>
                          )}
                          {row.status === "invalid" && (
                            <Badge variant="destructive" data-testid={`status-preview-${i}`}>
                              Invalid Row
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {priceImportPreview && priceImportPreview.length === 0 && (
              <p className="text-sm text-muted-foreground text-center">No rows found in the file.</p>
            )}
          </div>

          {priceImportPreview && priceImportPreview.some((r) => r.status === "will_update") && (
            <div className="flex justify-between items-center pt-2 border-t gap-2 flex-wrap">
              <p className="text-sm text-muted-foreground">
                {priceImportPreview.filter((r) => r.status === "will_update").length} item(s) will be updated
                {priceImportPreview.some((r) => r.status === "not_found") &&
                  ` · ${priceImportPreview.filter((r) => r.status === "not_found").length} not found`}
                {priceImportPreview.some((r) => r.status === "not_in_container") &&
                  ` · ${priceImportPreview.filter((r) => r.status === "not_in_container").length} not in this container`}
              </p>
              <Button
                onClick={() => {
                  const rows = priceImportPreview
                    .filter(
                      (r): r is ContainerPriceImportPreviewRow & { lineItemIds: number[]; newRate: number } =>
                        r.status === "will_update" && !!r.lineItemIds?.length && r.newRate != null
                    )
                    .map((r) => ({ lineItemIds: r.lineItemIds, newRate: r.newRate }));
                  priceApplyMutation.mutate(rows);
                }}
                disabled={priceApplyMutation.isPending}
                data-testid="button-save-price-import"
              >
                {priceApplyMutation.isPending ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
