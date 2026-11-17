// Extracted from ./CompaniesTab.tsx to keep that module under the source-size cap.
import { Building2, Edit, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ParentCreditAccountSelect } from "./ParentCreditAccountSelect";
import {
  CompaniesTabAlertDialogSection,
  CompaniesTabSection,
  useCompaniesTabState,
  type CompanyFormValues,
} from "./useCompaniesTabState";

export function CompaniesTab() {
  const {
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
    setDeleteConfirmationCode,
    setForceDeleteWithHistory,
    setShowInactive,
    showInactive,
    deleteConfirmationCode,
    forceDeleteWithHistory,
    setEditingCompany,
    setIsCompanyDialogOpen,
  } = useCompaniesTabState();

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
  const selectedDisplayCurrency = companyForm.watch("displayCurrency");
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Building2 className="h-6 w-6" />
            Company Management
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {companies.filter((company) => company.active).length} active companies
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
                          <SelectItem value="retail">Retail / Variant Inventory</SelectItem>
                          <SelectItem value="factory">Factory Production</SelectItem>
                          <SelectItem value="properties">Properties</SelectItem>
                          <SelectItem value="supplier_partner">Supplier Partner</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <CompaniesTabSection companyForm={companyForm} />
                {selectedDisplayCurrency === "ZMW" && (
                  <p className="text-xs text-muted-foreground" data-testid="zambia-zmw-currency-note">
                    Kwacha pricing uses a USD accounting base. After saving, set the company's daily USD/ZMW rate in
                    Exchange Rates before entering ZMW transactions. In Company Timezone, select Africa/Lusaka for
                    Zambia's correct business day. Existing voucher balances are not converted.
                  </p>
                )}
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
                      <FormLabel className="mt-0!">Active</FormLabel>
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
      <div className="flex flex-wrap items-center gap-4">
        {companies.length > 3 && (
          <SearchField
            placeholder="Search companies…"
            value={companySearch}
            onValueChange={setCompanySearch}
            wrapperClassName="max-w-xs"
            data-testid="input-company-search"
          />
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={showInactive}
            onCheckedChange={(checked) => setShowInactive(checked === true)}
            data-testid="checkbox-show-inactive-companies"
          />
          Show inactive ({companies.filter((company) => !company.active).length})
        </label>
      </div>
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
            (c) =>
              (showInactive ? !c.active : c.active) &&
              (!q || c.name?.toLowerCase().includes(q) || c.code?.toLowerCase().includes(q))
          );

          if (filtered.length === 0) {
            return (
              <p className="text-sm text-muted-foreground text-center py-10">
                {showInactive ? "No inactive companies match the search." : "No active companies match the search."}
              </p>
            );
          }

          return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((company) => {
                const isFactory = company.companyType === "factory" || company.companyType === "factory_v2";
                const isProperties = company.companyType === "properties";
                const isSupplierPartner = company.companyType === "supplier_partner";
                const isRetail = company.companyType === "retail";
                const parentCompany = companies.find(
                  (candidate) => Number(candidate.id) === Number(company.parentCompanyId)
                );
                const typeLabel = isFactory
                  ? "Factory"
                  : isProperties
                    ? "Properties"
                    : isSupplierPartner
                      ? "Supplier Partner"
                      : isRetail
                        ? "Retail"
                        : "ERP";

                const accentClass = isFactory
                  ? "bg-orange-500"
                  : isProperties
                    ? "bg-green-500"
                    : isSupplierPartner
                      ? "bg-rose-500"
                      : isRetail
                        ? "bg-sky-500"
                        : "bg-indigo-500";

                const typeBadgeClass = isFactory
                  ? "border-orange-200 text-orange-700 bg-orange-50 dark:border-orange-800 dark:text-orange-300 dark:bg-orange-950"
                  : isProperties
                    ? "border-green-200 text-green-700 bg-green-50 dark:border-green-800 dark:text-green-300 dark:bg-green-950"
                    : isSupplierPartner
                      ? "border-rose-200 text-rose-700 bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:bg-rose-950"
                      : isRetail
                        ? "border-sky-200 text-sky-700 bg-sky-50 dark:border-sky-800 dark:text-sky-300 dark:bg-sky-950"
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
                      {!company.active && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            setCompanyToDelete(company);
                            setDeleteConfirmationCode("");
                            setForceDeleteWithHistory(false);
                          }}
                          data-testid={`button-delete-company-${company.id}`}
                          title="Delete company"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()
      )}

      <CompaniesTabAlertDialogSection
        companyToDelete={companyToDelete}
        deleteCompanyMutation={deleteCompanyMutation}
        deleteConfirmationCode={deleteConfirmationCode}
        forceDeleteWithHistory={forceDeleteWithHistory}
        setCompanyToDelete={setCompanyToDelete}
        setDeleteConfirmationCode={setDeleteConfirmationCode}
        setForceDeleteWithHistory={setForceDeleteWithHistory}
      />
    </div>
  );
}
