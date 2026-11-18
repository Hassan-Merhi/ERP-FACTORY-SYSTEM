// Extracted from ./EditSupplier.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { insertSupplierSchema } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";
import type { ApiListRow } from "@shared/apiTypes";

type SupplierFormValues = {
  code: string;
  legalName: string;
  email: string;
  phone: string;
  address: string;
  taxId: string;
  paymentTerms: string;
  openingBalance: string;
  active: boolean;
  stockGroupId: number | null;
};

export function useEditSupplierState() {
  const params = useParams();
  const [, navigate] = useLocation();
  const handleBack = useBackToParent();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const supplierId = params.id ? parseInt(params.id) : null;
  useEscapeToParent(selectedCompany?.companyType === "properties" ? "/properties/suppliers" : "/suppliers");

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

  const form = useForm<SupplierFormValues>({
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
    mutationFn: async (data: SupplierFormValues) => {
      const res = await apiRequest("PATCH", `/api/suppliers/${supplierId}`, data);
      return (await res.json()) as { legalName?: string };
    },
    onSuccess: (data) => {
      toast({
        title: "Updated",
        description: `Supplier "${data.legalName}" updated successfully`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers/stats"] });
      queryClient.invalidateQueries({ queryKey: [`/api/suppliers/${supplierId}`] });
      navigate(selectedCompany?.companyType === "properties" ? "/properties/suppliers" : "/suppliers");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Update failed",
        description: error.message || "Failed to update supplier",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: SupplierFormValues) => {
    updateMutation.mutate(data);
  };
  return { navigate, handleBack, isLoading, supplier, stockGroups, form, updateMutation, onSubmit };
}
