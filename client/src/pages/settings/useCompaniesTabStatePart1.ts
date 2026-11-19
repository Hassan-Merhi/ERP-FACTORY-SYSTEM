// Extracted from ./useCompaniesTabState.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { type Company, insertCompanySchema } from "@shared/schema";

export type CompanyFormValues = z.infer<typeof insertCompanySchema>;

export function useCompaniesTabStatePart1() {
  const { toast } = useToast();
  const [isCompanyDialogOpen, setIsCompanyDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [companySearch, setCompanySearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [companyToDelete, setCompanyToDelete] = useState<Company | null>(null);
  const [deleteConfirmationCode, setDeleteConfirmationCode] = useState("");
  const [forceDeleteWithHistory, setForceDeleteWithHistory] = useState(false);
  const {
    data: companies = [],
    isLoading: isLoadingCompanies,
    isError: isCompaniesError,
    refetch: refetchCompanies,
  } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const companyForm = useForm<CompanyFormValues>({
    resolver: zodResolver(insertCompanySchema),
    defaultValues: {
      name: "",
      code: "",
      companyType: "erp",
      active: true,
      baseCurrency: "USD",
      displayCurrency: "none",
      parentCompanyId: undefined,
    },
  });

  const createCompanyMutation = useMutation({
    mutationFn: async (data: CompanyFormValues) => {
      const payload = { ...data, displayCurrency: data.displayCurrency === "none" ? null : data.displayCurrency };
      if (editingCompany) {
        const res = await apiRequest("PATCH", `/api/companies/${editingCompany.id}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/companies", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      toast({
        title: editingCompany ? "Updated" : "Created",
        description: editingCompany ? "Company updated." : "Company created.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/companies"] });
      if (editingCompany) {
        queryClient.invalidateQueries({ queryKey: [`/api/companies/${editingCompany.id}`] });
        queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates"] });
      }

      // Supplier visibility for PO Import depends on companies.parentCompanyId.
      // A cached empty supplier list can otherwise survive for the normal
      // 30-minute reference-data stale window after creating/editing a company.
      // Remove both the strict and inherited supplier caches so the next picker
      // request is guaranteed to use the relationship just saved.
      queryClient.removeQueries({
        predicate: (query) => {
          const first = query.queryKey[0];
          return typeof first === "string" && first.startsWith("/api/suppliers");
        },
      });

      setIsCompanyDialogOpen(false);
      setEditingCompany(null);
      companyForm.reset({
        name: "",
        code: "",
        companyType: "erp",
        active: true,
        baseCurrency: "USD",
        displayCurrency: "none",
        parentCompanyId: undefined,
      });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Save failed", description: error.message || "Failed to save company.", variant: "destructive" });
    },
  });

  const deleteCompanyMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/companies/${id}`, {
        forceDeleteWithHistory,
        confirmedCompanyCode: deleteConfirmationCode,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Company deleted successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/companies"] });
      setCompanyToDelete(null);
      setDeleteConfirmationCode("");
      setForceDeleteWithHistory(false);
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: "Delete failed",
        description: error.message || "Failed to delete company.",
        variant: "destructive",
      });
    },
  });

  function handleEditCompany(company: Company) {
    setEditingCompany(company);
    companyForm.reset({
      name: company.name,
      code: company.code,
      companyType: (company.companyType || "erp") as CompanyFormValues["companyType"],
      active: company.active ?? true,
      baseCurrency: company.baseCurrency || "USD",
      displayCurrency: company.displayCurrency || "none",
      parentCompanyId: company.parentCompanyId ?? null,
    });
    setIsCompanyDialogOpen(true);
  }
  return {
    isCompanyDialogOpen,
    setIsCompanyDialogOpen,
    editingCompany,
    setEditingCompany,
    companySearch,
    setCompanySearch,
    setShowInactive,
    showInactive,
    companyToDelete,
    setCompanyToDelete,
    deleteConfirmationCode,
    setDeleteConfirmationCode,
    forceDeleteWithHistory,
    setForceDeleteWithHistory,
    refetchCompanies,
    isCompaniesError,
    companies,
    isLoadingCompanies,
    companyForm,
    createCompanyMutation,
    deleteCompanyMutation,
    handleEditCompany,
  };
}
