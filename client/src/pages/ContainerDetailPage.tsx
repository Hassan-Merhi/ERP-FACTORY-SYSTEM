import { useState } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { useCompany } from "@/contexts/CompanyContext";
import { queryClient } from "@/lib/queryClient";
import { SpOffloadDialog } from "@/components/SpOffloadDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Truck, Edit, Download, ChevronDown, Printer } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { utils, writeFile, ExcelJS } from "@/lib/excelHelper";
import { spContainerInvoiceChargeLines } from "@shared/spContainerInvoiceCharges";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import ContainerDetailERP from "./ContainerDetail";
import type { SpContainerDetailResponse } from "./containers/types";

function fmt2(v: number | string | null | undefined) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? "$0.00" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmt4(v: number | string | null | undefined) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? "$0.0000" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

const editSchema = z.object({
  supplierId: z.number().optional(),
  supplierName: z.string().min(1, "Required"),
  containerNumber: z.string().optional(),
  invoiceNumber: z.string().min(1, "Required"),
  invoiceDate: z.string().min(1, "Required"),
  invoiceTotalUsd: z.string().min(1, "Required"),
  discountPct: z.string().optional(),
  freightEstimateUsd: z.string().optional(),
  notes: z.string().optional(),
});
type EditForm = z.infer<typeof editSchema>;

export default function ContainerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompany } = useCompany();
  const isSupplierPartner = selectedCompany?.companyType === "supplier_partner";

  // ERP containers viewed from the SP list are tagged with ?src=erp — render
  // the standard ERP detail page directly without trying the SP lookup first.
  const srcErp = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("src") === "erp";

  if (!isSupplierPartner || srcErp) {
    return <ContainerDetailERP id={id} forceErp={srcErp} />;
  }

  return <SpContainerDetailView />;
}

function SpContainerDetailView() {
  const { id } = useParams<{ id: string }>();
  const [showOffloadDialog, setShowOffloadDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();

  const { data: spc, isLoading } = useQuery<SpContainerDetailResponse>({
    queryKey: [`/api/sp/containers/${id}`],
    queryFn: () => fetch(`/api/sp/containers/${id}`, { credentials: "include" }).then((r) => r.json()),
    enabled: !!id,
  });

  const { data: suppliers = [] } = useQuery<{ id: number; legalName: string; code: string }[]>({
    queryKey: ["/api/suppliers"],
  });

  const editForm = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      supplierId: undefined,
      supplierName: "",
      containerNumber: "",
      invoiceNumber: "",
      invoiceDate: "",
      invoiceTotalUsd: "",
      discountPct: "0",
      freightEstimateUsd: "0",
      notes: "",
    },
  });

  const editMutation = useMutation({
    mutationFn: async (data: EditForm) => {
      const res = await fetch(`/api/sp/containers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update container");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/sp/containers/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      toast({ title: "Container updated", description: "Accounting voucher has been regenerated." });
      setShowEditDialog(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const openEdit = () => {
    if (!spc || "message" in spc) return;
    editForm.reset({
      supplierId: spc.supplierId ?? undefined,
      supplierName: spc.supplierName ?? "",
      containerNumber: spc.containerNumber ?? "",
      invoiceNumber: spc.invoiceNumber ?? "",
      invoiceDate: spc.invoiceDate ?? "",
      invoiceTotalUsd: spc.invoiceTotalUsd ?? "",
      discountPct: spc.discountPct ?? "0",
      freightEstimateUsd: spc.freightEstimateUsd ?? "0",
      notes: spc.notes ?? "",
    });
    setShowEditDialog(true);
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4" data-testid="sp-container-detail">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  // The skeleton return above guarantees loading has finished here, so a
  // missing body or `{ message }` error body means the container is not an SP
  // container — fall back to the ERP detail page.
  if (!spc || "message" in spc) {
    return <ContainerDetailERP />;
  }

  const discountFactor = 1 - parseFloat(spc.discountPct ?? "0") / 100;
  const baseCostAfterDiscount = (spc.lines ?? []).reduce((sum: number, l) => {
    return sum + parseFloat(l.qty ?? "0") * parseFloat(l.unitRateUsd ?? "0") * discountFactor;
  }, 0);

  const title = spc.containerNumber || spc.invoiceNumber || "Container #" + spc.id;
  const invoiceCharges = spContainerInvoiceChargeLines(spc);
  const chargesTotal = invoiceCharges.reduce((total, charge) => total + charge.amountUsd, 0);
  const totalQty = (spc.lines ?? []).reduce((sum, line) => sum + parseFloat(line.qty ?? "0"), 0);
  const grossItemsTotal = (spc.lines ?? []).reduce(
    (sum, line) => sum + parseFloat(line.qty ?? "0") * parseFloat(line.unitRateUsd ?? "0"),
    0
  );
  const discountTotal = grossItemsTotal - baseCostAfterDiscount;

  const exportInvoice = async (includeCosts: boolean) => {
    try {
      const fileBase = "container_" + String(title).replace(/[^a-z0-9-]/gi, "_");
      if (includeCosts) {
        // Same columns and worksheet name used by ERP's Full Export.
        const items = (spc.lines ?? []).map((line) => ({
          Code: line.articleCode || "",
          Name: line.description || line.articleCode,
          Qty: line.qty || "0",
          Rate: String(parseFloat(line.unitRateUsd ?? "0") * discountFactor),
          Value: String(parseFloat(line.qty ?? "0") * parseFloat(line.unitRateUsd ?? "0") * discountFactor),
        }));
        const workbook = utils.book_new();
        utils.book_append_sheet(workbook, utils.json_to_sheet(items), "Container Items");
        if (invoiceCharges.length > 0) {
          utils.book_append_sheet(
            workbook,
            utils.json_to_sheet(
              invoiceCharges.map((charge) => ({
                Type: charge.kind,
                Description: charge.description,
                "Amount (USD)": charge.amountUsd,
              }))
            ),
            "Extra Charges"
          );
        }
        utils.book_append_sheet(
          workbook,
          utils.json_to_sheet([
            {
              "Invoice / PO": spc.invoiceNumber || "",
              "Container Number": spc.containerNumber || "",
              Supplier: spc.supplierName || "",
              "Invoice Date": spc.invoiceDate || "",
              "Items Total": baseCostAfterDiscount,
              "Charges Total": chargesTotal,
              "Recorded Invoice Total": Number(spc.invoiceTotalUsd || 0),
            },
          ]),
          "Summary"
        );
        await writeFile(workbook, fileBase + ".xlsx");
      } else {
        // Same printable NO / hidden BARCODE / DESCRIPTION / Q'TY layout as ERP.
        const book = new ExcelJS.Workbook();
        const sheet = book.addWorksheet("Container Items");
        sheet.columns = [
          { key: "no", width: 6 },
          { key: "bc", width: 20, hidden: true },
          { key: "desc", width: 70 },
          { key: "qty", width: 18 },
        ];
        sheet.addRow([spc.supplierName || "", "", "", ""]);
        sheet.mergeCells("A1:D1");
        sheet.addRow(["CONTAINER: " + (spc.containerNumber || ""), "", "", ""]);
        sheet.mergeCells("A2:D2");
        sheet.addRow(["NO", "BARCODE", "DESCRIPTION", "Q'TY"]);
        (spc.lines ?? []).forEach((line, index) => {
          sheet.addRow([
            index + 1,
            line.articleCode || "",
            line.description || line.articleCode,
            Number(line.qty || 0),
          ]);
        });
        sheet.getRow(1).font = { bold: true, size: 13 };
        sheet.getRow(3).font = { bold: true };
        sheet.getColumn(4).numFmt = "#,##0.###";
        await writeFile(book, fileBase + "_no_cost.xlsx");
      }
      toast({ title: "Export successful", description: "Container data downloaded as Excel" });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-col h-full" data-testid="sp-container-detail">
      {/* ERP-standard detail header; native SP records still use SP accounting and lifecycle APIs. */}
      <PageHeader
        title={<span data-testid="text-container-number">Container {title}</span>}
        backTarget="/containers"
        meta={
          <>
            <Badge
              variant={spc.status === "offloaded" ? "secondary" : "default"}
              data-testid={"badge-sp-status-" + spc.id}
            >
              {spc.status === "offloaded" ? "OFFLOADED" : "OTW"}
            </Badge>
            <span>
              Invoice {spc.invoiceNumber} · {spc.invoiceDate ? formatDisplayDate(spc.invoiceDate) : "—"}
            </span>
          </>
        }
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2" data-testid="button-actions-dropdown">
              Actions <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {spc.status === "open" && (
              <>
                <DropdownMenuItem onClick={openEdit} data-testid="button-sp-edit">
                  <Edit className="h-4 w-4 mr-2" /> Edit Container
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowOffloadDialog(true)} data-testid="button-sp-offload">
                  <Truck className="h-4 w-4 mr-2" /> Offload Container
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2" data-testid="button-export-dropdown">
              <Download className="h-4 w-4" /> Export <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => void exportInvoice(true)} data-testid="button-export-excel">
              <Download className="h-4 w-4 mr-2" /> Full Export
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportInvoice(false)} data-testid="button-export-no-cost">
              <Download className="h-4 w-4 mr-2" /> No Cost / Freight Export
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.print()} data-testid="button-export-pdf">
              <Printer className="h-4 w-4 mr-2" /> Export PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 md:p-6 space-y-5">
        {/* Same summary structure and labels as the ERP container detail. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground uppercase">Supplier</CardTitle>
            </CardHeader>
            <CardContent className="font-semibold">
              {spc.supplierName || "—"}
              <p className="text-xs font-normal text-muted-foreground">{spc.invoiceNumber}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground uppercase">Items Total</CardTitle>
            </CardHeader>
            <CardContent className="text-xl font-semibold tabular-nums">
              {fmt2(baseCostAfterDiscount)}
              <p className="text-xs font-normal text-muted-foreground">{spc.lines.length} items in 1 PO(s)</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground uppercase">Grand Total</CardTitle>
            </CardHeader>
            <CardContent className="text-xl font-semibold tabular-nums">
              {fmt2(spc.invoiceTotalUsd)}
              {chargesTotal !== 0 && (
                <p className="text-xs font-normal text-muted-foreground">
                  Including {fmt2(chargesTotal)} invoice charges
                </p>
              )}
            </CardContent>
          </Card>
        </div>
        {/* Purchase order layout matches the ERP container view. Article codes remain in storage, not the table. */}
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Purchase Orders</h3>
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="flex justify-between bg-muted/40 px-4 py-3 text-sm font-semibold">
            <span>
              {spc.invoiceNumber} <span className="text-muted-foreground font-normal ml-2">USD</span>
            </span>
            <span className="tabular-nums">{fmt2(baseCostAfterDiscount)}</span>
          </div>
          <Table mobileLayout="cards">
            <TableHeader>
              <TableRow>
                <TableHead>Item Name</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(spc.lines ?? []).map((line) => {
                const qty = parseFloat(line.qty ?? "0");
                const rate = parseFloat(line.unitRateUsd ?? "0") * discountFactor;
                const total = qty * rate;
                return (
                  <TableRow key={line.id} data-testid={"row-sp-line-" + line.id}>
                    <TableCell className={total < 0 ? "text-red-600 font-medium" : ""}>
                      {line.description || line.articleCode}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {qty.toLocaleString("en-US", { maximumFractionDigits: 3 })}
                    </TableCell>
                    <TableCell className={"text-right tabular-nums " + (rate < 0 ? "text-red-600" : "")}>
                      {fmt4(rate)}
                    </TableCell>
                    <TableCell className={"text-right tabular-nums font-semibold " + (total < 0 ? "text-red-600" : "")}>
                      {fmt2(total)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {spc.lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-6 text-muted-foreground">
                    No line items
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {invoiceCharges.length > 0 && (
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="bg-muted/40 px-4 py-3 text-sm font-semibold">Extra Charges</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Misc Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoiceCharges.map((charge) => (
                  <TableRow key={charge.kind}>
                    <TableCell>{charge.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt2(charge.amountUsd)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/20 font-semibold">
                  <TableCell>Total Charges</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt2(chargesTotal)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
        <div className="rounded-lg border bg-card p-4 space-y-2 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</p>
          <div className="flex justify-between">
            <span>Items Total</span>
            <span>{fmt2(baseCostAfterDiscount)}</span>
          </div>
          {discountTotal > 0 && (
            <div className="flex justify-between text-red-600">
              <span>Discount ({spc.discountPct}%)</span>
              <span>-{fmt2(discountTotal)}</span>
            </div>
          )}
          {chargesTotal !== 0 && (
            <div className="flex justify-between">
              <span>Charges Total</span>
              <span>{fmt2(chargesTotal)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Total Qty</span>
            <span>{totalQty.toLocaleString("en-US", { maximumFractionDigits: 3 })}</span>
          </div>
          <div className="flex justify-between border-t pt-2 font-bold">
            <span>Grand Total (Recorded Invoice)</span>
            <span>{fmt2(spc.invoiceTotalUsd)}</span>
          </div>
        </div>

        {/* Prepaid Charges */}
        {(spc.prepaid ?? []).length > 0 && (
          <Card>
            <CardHeader className="px-4 pt-4 pb-2">
              <CardTitle className="text-sm">Prepaid Charges</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Amount (USD)</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(spc.prepaid ?? []).map((charge) => (
                    <TableRow key={charge.id}>
                      <TableCell className="text-sm capitalize">
                        {charge.chargeType?.replace(/_/g, " ") ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {charge.notes || charge.agentName || "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums font-medium">
                        {fmt2(charge.amountPaidUsd)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{charge.prepaidDate ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Offload Summary */}
        {spc.status === "offloaded" && spc.offload && (
          <Card>
            <CardHeader className="px-4 pt-4 pb-2">
              <CardTitle className="text-sm">
                Offload Summary
                <span className="ml-2 font-normal text-muted-foreground text-xs">{spc.offload.offloadDate}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(spc.offloadCharges ?? []).length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount (USD)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(spc.offloadCharges ?? []).map((charge) => (
                      <TableRow key={charge.id}>
                        <TableCell className="text-sm capitalize">
                          {charge.chargeType?.replace(/_/g, " ") ?? "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{charge.description || "—"}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums font-medium">
                          {fmt2(charge.amountUsd)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="px-4 pb-4 text-sm text-muted-foreground">No charges recorded.</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Notes */}
        {spc.notes && (
          <Card>
            <CardHeader className="px-4 pt-4 pb-2">
              <CardTitle className="text-sm">Notes</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{spc.notes}</p>
            </CardContent>
          </Card>
        )}
      </div>

      <SpOffloadDialog
        open={showOffloadDialog}
        onOpenChange={setShowOffloadDialog}
        container={spc}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: [`/api/sp/containers/${id}`] });
          queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
          setShowOffloadDialog(false);
        }}
      />

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Container</DialogTitle>
            <DialogDescription>
              Update the container details. The accounting voucher (Dr Goods OTW / Cr OTW Clearing) will be regenerated
              automatically.
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit((d) => editMutation.mutate(d))} className="space-y-4" noValidate>
              <FormField
                control={editForm.control}
                name="supplierId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Supplier</FormLabel>
                    <Select
                      value={field.value ? String(field.value) : ""}
                      onValueChange={(val) => {
                        const numId = parseInt(val);
                        field.onChange(numId);
                        const found = suppliers.find((s) => s.id === numId);
                        if (found) editForm.setValue("supplierName", found.legalName);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-edit-supplier">
                          <SelectValue placeholder="Select supplier…" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {suppliers.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            {s.legalName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={editForm.control}
                name="supplierName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Supplier Name <span className="text-muted-foreground text-xs font-normal">(override)</span>
                    </FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-edit-supplier-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={editForm.control}
                  name="invoiceNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice Number</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-edit-invoice-number" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="containerNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Container No. <span className="text-muted-foreground text-xs font-normal">(opt.)</span>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="ABCD1234567" data-testid="input-edit-container-number" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="invoiceDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} data-testid="input-edit-invoice-date" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="invoiceTotalUsd"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice Total (USD)</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" {...field} data-testid="input-edit-invoice-total" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="discountPct"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Discount %</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" {...field} data-testid="input-edit-discount-pct" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="freightEstimateUsd"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Freight Estimate (USD)</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" {...field} data-testid="input-edit-freight-estimate" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={editForm.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Notes <span className="text-muted-foreground text-xs font-normal">(opt.)</span>
                    </FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-edit-notes" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowEditDialog(false)}
                  data-testid="button-edit-cancel"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={editMutation.isPending} data-testid="button-edit-submit">
                  {editMutation.isPending ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
