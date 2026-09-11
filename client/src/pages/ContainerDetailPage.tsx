import { useState } from "react";
import { useParams, useLocation } from "wouter";
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
import { ArrowLeft, Truck, Edit } from "lucide-react";
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
  const [, navigate] = useLocation();
  const [showOffloadDialog, setShowOffloadDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const { toast } = useToast();

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

  const title = spc.invoiceNumber || spc.containerNumber || `Container #${spc.id}`;

  return (
    <div className="flex flex-col h-full" data-testid="sp-container-detail">
      {/* Header */}
      <div className="border-b px-4 md:px-6 py-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/containers")} data-testid="button-sp-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-lg font-semibold leading-tight">{title}</h1>
              <p className="text-sm text-muted-foreground">{spc.supplierName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className={
                spc.status === "offloaded" ? "text-green-600 border-green-600/40" : "text-blue-600 border-blue-600/40"
              }
              data-testid={`badge-sp-status-${spc.id}`}
            >
              {spc.status === "offloaded" ? "Offloaded" : "Open / OTW"}
            </Badge>
            {spc.status !== "offloaded" && (
              <>
                <Button variant="outline" onClick={openEdit} data-testid="button-sp-edit">
                  <Edit className="h-4 w-4 mr-2" />
                  Edit
                </Button>
                <Button onClick={() => setShowOffloadDialog(true)} data-testid="button-sp-offload">
                  <Truck className="h-4 w-4 mr-2" />
                  Offload
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 md:p-6 space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-1 pt-4 px-4">
              <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Invoice Total
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-xl font-semibold tabular-nums">{fmt2(spc.invoiceTotalUsd)}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1 pt-4 px-4">
              <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Discount
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-xl font-semibold tabular-nums">{parseFloat(spc.discountPct ?? "0").toFixed(2)}%</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1 pt-4 px-4">
              <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Base Cost (after disc.)
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-xl font-semibold tabular-nums">{fmt2(baseCostAfterDiscount)}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1 pt-4 px-4">
              <CardTitle className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Invoice Date
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-xl font-semibold">{spc.invoiceDate ?? "—"}</p>
            </CardContent>
          </Card>
        </div>

        {/* Line Items */}
        <Card>
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-sm">Line Items</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Article Code</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Rate (USD)</TableHead>
                  <TableHead className="text-right">Disc. Rate</TableHead>
                  <TableHead className="text-right">Line Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(spc.lines ?? []).map((line) => {
                  const qty = parseFloat(line.qty ?? "0");
                  const unitRate = parseFloat(line.unitRateUsd ?? "0");
                  const discRate = unitRate * discountFactor;
                  const lineCost = qty * discRate;
                  return (
                    <TableRow key={line.id} data-testid={`row-sp-line-${line.id}`}>
                      <TableCell className="font-mono text-sm">{line.articleCode}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{line.description || "—"}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{qty.toFixed(2)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{fmt4(unitRate)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{fmt4(discRate)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums font-medium">{fmt2(lineCost)}</TableCell>
                    </TableRow>
                  );
                })}
                {(spc.lines ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground text-sm py-6">
                      No line items
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

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
