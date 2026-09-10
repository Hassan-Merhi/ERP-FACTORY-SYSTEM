import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { Plus, Building2, Search, Edit, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ParentCreditAccountSelect } from "./ParentCreditAccountSelect";
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
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { insertCompanySchema } from "@shared/schema";

type CompanyFormValues = z.infer<typeof insertCompanySchema>;

export function CompaniesTab() {
  const { toast } = useToast();
  const [isCompanyDialogOpen, setIsCompanyDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<any>(null);
  const [companySearch, setCompanySearch] = useState("");
  const [companyToDelete, setCompanyToDelete] = useState<any>(null);

  const { data: companies = [], isLoading: isLoadingCompanies } = useQuery<any[]>({
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

  function handleEditCompany(company: any) {
    setEditingCompany(company);
    companyForm.reset({
      name: company.name,
      code: company.code,
      companyType: company.companyType || "erp",
      active: company.active ?? true,
      baseCurrency: company.baseCurrency || "USD",
      displayCurrency: company.displayCurrency || "none",
      parentCompanyId: company.parentCompanyId ?? null,
    });
    setIsCompanyDialogOpen(true);
  }

  function handleSubmitCompany(data: CompanyFormValues) {
    if (data.companyType !== "properties" && data.parentCompanyId === undefined) {
      companyForm.setError("parentCompanyId", {
        type: "manual",
        message: "Choose a parent company or explicitly select Standalone / No Parent.",
      });
      return;
    }
    createCompanyMutation.mutate(data);
  }

  const selectedCompanyType = companyForm.watch("companyType");
  const selectedParentCompanyId = companyForm.watch("parentCompanyId");
  const editingCompanyId = Number(editingCompany?.id ?? 0);
  const activeParentCompanies = companies.filter(
    (company) => company.active && company.companyType !== "properties" && Number(company.id) !== editingCompanyId
  );
  const selectedParentCompany = companies.find((company) => Number(company.id) === Number(selectedParentCompanyId));
  const parentCompanyOptions =
    selectedParentCompany &&
    !activeParentCompanies.some((company) => Number(company.id) === Number(selectedParentCompanyId))
      ? [selectedParentCompany, ...activeParentCompanies]
      : activeParentCompanies;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Building2 className="h-6 w-6" />
            Company Management
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {companies.length} {companies.length === 1 ? "company" : "companies"} configured
          </p>
        </div>
        <Dialog
          open={isCompanyDialogOpen}
          onOpenChange={(open) => {
            setIsCompanyDialogOpen(open);
            if (!open) {
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
            }
          }}
        >
          <DialogTrigger asChild>
            <Button
              onClick={() => {
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
              }}
              data-testid="button-add-company"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Company
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editingCompany ? "Edit Company" : "Create New Company"}</DialogTitle>
            </DialogHeader>
            <Form {...companyForm}>
              <form onSubmit={companyForm.handleSubmit(handleSubmitCompany)} className="space-y-4" noValidate>
                <FormField
                  control={companyForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company Name *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="ABC Textiles Inc." data-testid="input-company-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={companyForm.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company Code *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="ABC" data-testid="input-company-code" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={companyForm.control}
                  name="companyType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company Type</FormLabel>
                      <Select
                        onValueChange={(value) => {
                          field.onChange(value);
                          if (value === "properties") companyForm.setValue("parentCompanyId", undefined);
                        }}
                        value={field.value || "erp"}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-company-type">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="erp">Normal ERP</SelectItem>
                          <SelectItem value="factory">Factory Production</SelectItem>
                          <SelectItem value="properties">Properties</SelectItem>
                          <SelectItem value="supplier_partner">Supplier Partner</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
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
                            <SelectItem value="EUR">EUR</SelectItem>
                            <SelectItem value="GBP">GBP</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={companyForm.control}
                  name="active"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="checkbox-company-active"
                        />
                      </FormControl>
                      <FormLabel className="!mt-0">Active</FormLabel>
                    </FormItem>
                  )}
                />
                {selectedCompanyType !== "properties" && (
                  <FormField
                    control={companyForm.control}
                    name="parentCompanyId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Parent Company / Standalone *</FormLabel>
                        <Select
                          value={
                            field.value === undefined ? undefined : field.value === null ? "none" : String(field.value)
                          }
                          onValueChange={(value) => {
                            field.onChange(value === "none" ? null : Number(value));
                            companyForm.clearErrors("parentCompanyId");
                          }}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-parent-company">
                              <SelectValue placeholder="Choose parent or standalone" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">Standalone / No Parent</SelectItem>
                            {parentCompanyOptions.map((company) => (
                              <SelectItem key={company.id} value={String(company.id)} disabled={!company.active}>
                                {company.name} ({company.code}){!company.active ? " — inactive" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Child companies inherit parent suppliers for PO Import and use this relationship for
                          parent-side intercompany accounting. Choose Standalone only when the company truly has no
                          accounting parent.
                        </p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                {editingCompany && (
                  <div className="border-t pt-4">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                      Parent Credit Account
                    </p>
                    <ParentCreditAccountSelect company={editingCompany} />
                  </div>
                )}
                <div className="flex gap-2 justify-end border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setIsCompanyDialogOpen(false);
                      setEditingCompany(null);
                    }}
                    disabled={createCompanyMutation.isPending}
                    data-testid="button-cancel-company"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createCompanyMutation.isPending} data-testid="button-save-company">
                    {createCompanyMutation.isPending ? "Saving..." : "Save"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Search */}
      {companies.length > 3 && (
        <div className="relative max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search companies…"
            value={companySearch}
            onChange={(e) => setCompanySearch(e.target.value)}
            className="pl-9"
            data-testid="input-company-search"
          />
        </div>
      )}

      {/* Cards */}
      {isLoadingCompanies ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 rounded-md border bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : companies.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
          <Building2 className="h-12 w-12 text-muted-foreground/30" />
          <div>
            <p className="font-medium text-muted-foreground">No companies yet</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Click "Add Company" above to create your first one.</p>
          </div>
        </div>
      ) : (
        (() => {
          const q = companySearch.toLowerCase();
          const filtered = companies.filter(
            (c) => !q || c.name?.toLowerCase().includes(q) || c.code?.toLowerCase().includes(q)
          );

          if (filtered.length === 0) {
            return (
              <p className="text-sm text-muted-foreground text-center py-10">
                No companies match "<span className="font-medium">{companySearch}</span>"
              </p>
            );
          }

          return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((company) => {
                const isFactory = company.companyType === "factory" || company.companyType === "factory_v2";
                const isProperties = company.companyType === "properties";
                const isSupplierPartner = company.companyType === "supplier_partner";
                const parentCompany = companies.find(
                  (candidate) => Number(candidate.id) === Number(company.parentCompanyId)
                );
                const typeLabel = isFactory
                  ? "Factory"
                  : isProperties
                    ? "Properties"
                    : isSupplierPartner
                      ? "Supplier Partner"
                      : "ERP";

                const accentClass = isFactory
                  ? "bg-orange-500"
                  : isProperties
                    ? "bg-green-500"
                    : isSupplierPartner
                      ? "bg-rose-500"
                      : "bg-indigo-500";

                const typeBadgeClass = isFactory
                  ? "border-orange-200 text-orange-700 bg-orange-50 dark:border-orange-800 dark:text-orange-300 dark:bg-orange-950"
                  : isProperties
                    ? "border-green-200 text-green-700 bg-green-50 dark:border-green-800 dark:text-green-300 dark:bg-green-950"
                    : isSupplierPartner
                      ? "border-rose-200 text-rose-700 bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:bg-rose-950"
                      : "border-indigo-200 text-indigo-700 bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:bg-indigo-950";

                return (
                  <div
                    key={company.id}
                    className="rounded-md border bg-card flex flex-col overflow-hidden"
                    data-testid={`card-company-${company.id}`}
                  >
                    <div className={`h-1.5 w-full ${accentClass}`} />

                    <div className="flex flex-col gap-3 p-4 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className="font-semibold text-base leading-tight"
                          data-testid={`text-company-name-${company.id}`}
                        >
                          {company.name}
                        </p>
                        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${typeBadgeClass}`}
                            data-testid={`text-company-type-${company.id}`}
                          >
                            {typeLabel}
                          </span>
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                              company.active
                                ? "border-emerald-200 text-emerald-700 bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:bg-emerald-950"
                                : "border-border text-muted-foreground bg-muted"
                            }`}
                            data-testid={`text-company-status-${company.id}`}
                          >
                            {company.active ? "Active" : "Inactive"}
                          </span>
                        </div>
                      </div>

                      <div className="text-xs text-muted-foreground space-y-1">
                        <p>
                          {company.baseCurrency || "USD"}
                          {company.displayCurrency && company.displayCurrency !== "none"
                            ? ` · ${company.displayCurrency}`
                            : ""}
                        </p>
                        {!isProperties && (
                          <p data-testid={`text-company-parent-${company.id}`}>
                            Parent:{" "}
                            {parentCompany ? `${parentCompany.name} (${parentCompany.code})` : "Standalone / No Parent"}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="border-t px-4 py-2 flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleEditCompany(company)}
                        data-testid={`button-edit-company-${company.id}`}
                        title="Edit company"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setCompanyToDelete(company)}
                        data-testid={`button-delete-company-${company.id}`}
                        title="Delete company"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()
      )}

      {/* Delete confirmation */}
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
    </div>
  );
}
