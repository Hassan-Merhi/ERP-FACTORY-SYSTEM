import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Loader2 } from "lucide-react";
import { insertSupplierSchema } from "@shared/schema";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import type { ApiListRow } from "@shared/apiTypes";

export default function EditSupplier() {
  const params = useParams();
  const [_location, navigate] = useLocation();
  const handleBack = useBackToParent();
  const { toast } = useToast();
  const { formatAmount: _formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const supplierId = params.id ? parseInt(params.id) : null;
  useEscapeToParent("/suppliers");

  const { data: supplier, isLoading } = useQuery({
    queryKey: [`/api/suppliers/${supplierId}`],
    enabled: !!supplierId,
  });

  const { data: stockGroups = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/stock-groups", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    queryFn: async () => {
      const res = await fetch("/api/stock-groups", { credentials: "include" });
      return res.ok ? res.json() : [];
    },
  });

  const form = useForm({
    resolver: zodResolver(insertSupplierSchema.partial()),
    defaultValues: {
      code: "",
      legalName: "",
      email: "",
      phone: "",
      address: "",
      taxId: "",
      paymentTerms: "",
      openingBalance: "0.00",
      active: true,
      stockGroupId: null as number | null,
    },
  });

  useEffect(() => {
    if (supplier) {
      form.reset({
        code: String((supplier as { code: unknown }).code || ""),
        legalName: String((supplier as { legalName: unknown }).legalName || ""),
        email: String((supplier as { email: unknown }).email || ""),
        phone: String((supplier as { phone: unknown }).phone || ""),
        address: String((supplier as { address: unknown }).address || ""),
        taxId: String((supplier as { taxId: unknown }).taxId || ""),
        paymentTerms: String((supplier as { paymentTerms: unknown }).paymentTerms || ""),
        openingBalance: String((supplier as { openingBalance: unknown }).openingBalance || "0.00"),
        active: Boolean((supplier as { active: unknown }).active),
        stockGroupId:
          (supplier as { stockGroupId: number | null | undefined }).stockGroupId ??
          (supplier as { stock_group_id: number | null | undefined }).stock_group_id ??
          null,
      });
    }
  }, [form, supplier]);

  const updateMutation = useMutation({
    mutationFn: async (data) => {
      const res = await apiRequest("PATCH", `/api/suppliers/${supplierId}`, data);
      return await res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: `Supplier "${data.legalName}" updated successfully`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers/stats"] });
      queryClient.invalidateQueries({ queryKey: [`/api/suppliers/${supplierId}`] });
      navigate("/suppliers");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to update supplier",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: any) => {
    updateMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!supplier) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <PageHeader title="Supplier Not Found" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold" data-testid="text-page-title">
            Edit Supplier
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Update supplier information and opening balance</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Supplier Details</CardTitle>
          <CardDescription>Update the supplier information below</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Code *</FormLabel>
                      <FormControl>
                        <Input placeholder="SUP-001" {...field} data-testid="input-code" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="legalName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Legal Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Acme Corporation" {...field} data-testid="input-legalName" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email *</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="contact@supplier.com" {...field} data-testid="input-email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl>
                        <Input placeholder="+1 234 567 8900" {...field} data-testid="input-phone" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem className="col-span-1 sm:col-span-2">
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <Input placeholder="123 Business St, City, State" {...field} data-testid="input-address" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="taxId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tax ID (GST/VAT)</FormLabel>
                      <FormControl>
                        <Input placeholder="GST123456" {...field} data-testid="input-taxId" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="paymentTerms"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Payment Terms</FormLabel>
                      <FormControl>
                        <Input placeholder="Net 30" {...field} data-testid="input-paymentTerms" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="openingBalance"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Opening Balance</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          {...field}
                          data-testid="input-openingBalance"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="stockGroupId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Linked Stock Group</FormLabel>
                      <Select
                        value={field.value ? String(field.value) : "__none__"}
                        onValueChange={(v) => field.onChange(v === "__none__" ? null : Number(v))}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-stock-group">
                            <SelectValue placeholder="No stock group linked" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">No stock group linked</SelectItem>
                          {stockGroups.map((g) => (
                            <SelectItem key={g.id} value={String(g.id)}>
                              {g.name}
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
                  name="active"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 pt-8">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="checkbox-active"
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Active</FormLabel>
                      </div>
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigate("/suppliers")}
                  data-testid="button-cancel"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={updateMutation.isPending} data-testid="button-save">
                  {updateMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
