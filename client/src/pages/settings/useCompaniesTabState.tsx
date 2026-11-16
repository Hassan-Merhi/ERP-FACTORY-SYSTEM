// Extracted from ./CompaniesTab.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { type Company, insertCompanySchema } from "@shared/schema";

export type CompanyFormValues = z.infer<typeof insertCompanySchema>;

export function useCompaniesTabState() {
  const { toast } = useToast();
  const [isCompanyDialogOpen, setIsCompanyDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [companySearch, setCompanySearch] = useState("");
  const [companyToDelete, setCompanyToDelete] = useState<Company | null>(null);

  const { data: companies = [], isLoading: isLoadingCompanies } = useQuery<Company[]>({
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
      toast({ title: "Success", description: editingCompany ? "Company updated." : "Company created." });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
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
      toast({ title: "Error", description: error.message || "Failed to save company.", variant: "destructive" });
    },
  });

  const deleteCompanyMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/companies/${id}`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Company deleted successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      setCompanyToDelete(null);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Error", description: error.message || "Failed to delete company.", variant: "destructive" });
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
    companies,
    companyForm,
    companySearch,
    companyToDelete,
    createCompanyMutation,
    deleteCompanyMutation,
    editingCompany,
    handleEditCompany,
    isCompanyDialogOpen,
    isLoadingCompanies,
    setCompanySearch,
    setCompanyToDelete,
    setEditingCompany,
    setIsCompanyDialogOpen,
  };
}

export function CompaniesTabSection({ companyForm }: Pick<ReturnType<typeof useCompaniesTabState>, "companyForm">) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <FormField
        control={companyForm.control}
        name="baseCurrency"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Base Currency</FormLabel>
            <Select onValueChange={field.onChange} value={field.value || "USD"}>
              <FormControl>
                <SelectTrigger data-testid="select-base-currency">
                  <SelectValue placeholder="Select currency" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="EUR">EUR</SelectItem>
                <SelectItem value="GBP">GBP</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={companyForm.control}
        name="displayCurrency"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Display Currency</FormLabel>
            <Select onValueChange={field.onChange} value={field.value || "none"}>
              <FormControl>
                <SelectTrigger data-testid="select-display-currency">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="CFA">CFA</SelectItem>
                <SelectItem value="ZMW">ZMW — Zambian Kwacha (K)</SelectItem>
                <SelectItem value="EUR">EUR</SelectItem>
                <SelectItem value="GBP">GBP</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

export function CompaniesTabAlertDialogSection({
  companyToDelete,
  deleteCompanyMutation,
  setCompanyToDelete,
}: Pick<ReturnType<typeof useCompaniesTabState>, "companyToDelete" | "deleteCompanyMutation" | "setCompanyToDelete">) {
  return (
    <AlertDialog open={!!companyToDelete} onOpenChange={(open) => !open && setCompanyToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Company</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Are you sure you want to delete <strong>{companyToDelete?.name}</strong>?
              </p>
              <p className="text-destructive font-medium">
                This will permanently delete ALL data associated with this company, including:
              </p>
              <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                <li>All locations and inventory</li>
                <li>All ledger accounts and bank accounts</li>
                <li>All vouchers and transactions</li>
                <li>All purchase orders and containers</li>
                <li>All employees and customers</li>
                <li>All user role assignments for this company</li>
              </ul>
              <p className="font-bold text-destructive mt-2">This action cannot be undone!</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-delete-company">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => companyToDelete && deleteCompanyMutation.mutate(companyToDelete.id)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={deleteCompanyMutation.isPending}
            data-testid="button-confirm-delete-company"
          >
            {deleteCompanyMutation.isPending ? "Deleting..." : "Delete Company"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
