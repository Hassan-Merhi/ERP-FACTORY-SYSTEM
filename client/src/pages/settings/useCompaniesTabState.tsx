// Extracted from ./CompaniesTab.tsx to keep that module under the source-size cap.
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { useCompaniesTabStatePart1 } from "./useCompaniesTabStatePart1";
export type { CompanyFormValues } from "./useCompaniesTabStatePart1";

export function useCompaniesTabState() {
  const {
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
  } = useCompaniesTabStatePart1();
  return {
    refetchCompanies,
    isCompaniesError,
    companies,
    companyForm,
    deleteConfirmationCode,
    forceDeleteWithHistory,
    setDeleteConfirmationCode,
    setForceDeleteWithHistory,
    setShowInactive,
    showInactive,
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
  deleteConfirmationCode,
  forceDeleteWithHistory,
  setCompanyToDelete,
  setDeleteConfirmationCode,
  setForceDeleteWithHistory,
}: Pick<
  ReturnType<typeof useCompaniesTabState>,
  | "companyToDelete"
  | "deleteCompanyMutation"
  | "deleteConfirmationCode"
  | "forceDeleteWithHistory"
  | "setCompanyToDelete"
  | "setDeleteConfirmationCode"
  | "setForceDeleteWithHistory"
>) {
  return (
    <AlertDialog
      open={!!companyToDelete}
      onOpenChange={(open) => {
        if (!open) {
          setCompanyToDelete(null);
          setDeleteConfirmationCode("");
          setForceDeleteWithHistory(false);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Company</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Are you sure you want to delete <strong>{companyToDelete?.name}</strong>?
              </p>
              <p className="text-destructive font-medium">
                Inactive companies may be permanently deleted. Select the financial-history option below if the company
                has transactions or balances. Deletion removes associated records, including:
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
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={forceDeleteWithHistory}
                  onCheckedChange={(checked) => setForceDeleteWithHistory(checked === true)}
                  data-testid="checkbox-force-delete-history"
                />
                Permanently remove accounting history too (vouchers, inventory, closures and balances)
              </label>
              {forceDeleteWithHistory && (
                <div className="space-y-1">
                  <p className="text-sm">
                    Type company code <strong>{companyToDelete?.code}</strong> to confirm permanent deletion of its
                    financial records.
                  </p>
                  <Input
                    value={deleteConfirmationCode}
                    onChange={(event) => setDeleteConfirmationCode(event.target.value)}
                    placeholder="Exact company code"
                    data-testid="input-force-delete-company-code"
                    autoComplete="off"
                  />
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-delete-company">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => companyToDelete && deleteCompanyMutation.mutate(companyToDelete.id)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={
              deleteCompanyMutation.isPending ||
              (forceDeleteWithHistory && deleteConfirmationCode !== companyToDelete?.code)
            }
            data-testid="button-confirm-delete-company"
          >
            {deleteCompanyMutation.isPending ? "Deleting..." : "Delete Company"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
