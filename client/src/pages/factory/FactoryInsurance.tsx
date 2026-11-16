import { Shield, Plus, Trash2, DollarSign, Loader2, Receipt, Search, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MONTHS, YEARS } from "./factoryinsurance/utils";
import { MemberFormDialog } from "./factoryinsurance/components/MemberFormDialog";
import { MemberStatementDrawer } from "./factoryinsurance/components/MemberStatementDrawer";
import { InsuranceImportDialog } from "./factoryinsurance/components/InsuranceImportDialog";
import { InsuranceClearDialog } from "./factoryinsurance/components/InsuranceClearDialog";
import { useFactoryInsuranceState } from "./useFactoryInsuranceState";
import { FactoryInsuranceCardSection } from "./FactoryInsuranceCardSection";
import { FactoryInsuranceDialogSection, FactoryInsuranceSection } from "./FactoryInsuranceDialogSection";

export default function FactoryInsurance() {
  const {
    canClearInsurance,
    deleteMember,
    deleteMutation,
    ecAmount,
    ecCrId,
    ecCrOpen,
    ecCrRef,
    ecCrSearch,
    ecDate,
    ecDrId,
    ecDrOpen,
    ecDrRef,
    ecDrSearch,
    ecNotes,
    editMember,
    extraChargesMutation,
    filteredMembers,
    formatDisplayDate,
    genMonth,
    genYear,
    generateMutation,
    includeInactive,
    insExpenseBalance,
    insuranceExpenseAccount,
    isError,
    isLoading,
    ledgerAccounts,
    members,
    membersError,
    recordChanges,
    search,
    selectedCompany,
    setDeleteMember,
    setEcAmount,
    setEcCrId,
    setEcCrOpen,
    setEcCrSearch,
    setEcDate,
    setEcDrId,
    setEcDrOpen,
    setEcDrSearch,
    setEcNotes,
    setEditMember,
    setGenMonth,
    setGenYear,
    setIncludeInactive,
    setSearch,
    setShowAddDialog,
    setShowClearDialog,
    setShowExtraCharges,
    setShowGenDialog,
    setShowImportDialog,
    setStatementMember,
    showAddDialog,
    showClearDialog,
    showExtraCharges,
    showGenDialog,
    showImportDialog,
    statementMember,
    stats,
    toggleMutation,
  } = useFactoryInsuranceState();

  return (
    <div className="space-y-5 px-3 pb-6 pt-3 sm:px-6 sm:pt-5">
      {/* Payroll hub "Insurance" tab: the hub PageHeader titles the page; keep the actions only. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {recordChanges.allowed && canClearInsurance && (
          <Button
            variant="destructive"
            className="rounded-xl border border-red-400/30 bg-red-600 text-white shadow-sm shadow-red-700/15 hover:bg-red-700"
            onClick={() => setShowClearDialog(true)}
            data-testid="button-clear-all-insurance"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Clear All
          </Button>
        )}
        {recordChanges.allowed && (
          <>
            <Button
              variant="outline"
              className="rounded-xl border-slate-300/80 bg-white/75 text-slate-800 shadow-sm hover:bg-blue-50 dark:border-slate-600/80 dark:bg-slate-900/70 dark:text-slate-100 dark:hover:bg-blue-950/80"
              onClick={() => setShowImportDialog(true)}
              data-testid="button-import-insurance"
            >
              <FileSpreadsheet className="h-4 w-4 mr-1" />
              Import Excel
            </Button>
            <Button
              variant="outline"
              className="rounded-xl border-slate-300/80 bg-white/75 text-slate-800 shadow-sm hover:bg-blue-50 dark:border-slate-600/80 dark:bg-slate-900/70 dark:text-slate-100 dark:hover:bg-blue-950/80"
              onClick={() => setShowExtraCharges(true)}
              data-testid="button-extra-charges"
            >
              <Receipt className="h-4 w-4 mr-1" />
              Add Extra Charges
            </Button>
            <Button
              className="rounded-xl bg-gradient-to-r from-blue-700 to-blue-500 text-white shadow-md shadow-blue-700/20 hover:from-blue-800 hover:to-blue-600"
              onClick={() => setShowGenDialog(true)}
              data-testid="button-generate-entries"
            >
              <DollarSign className="h-4 w-4 mr-1" />
              Generate Entries
            </Button>
          </>
        )}
        {recordChanges.canCreate("POST", "/api/insurance/members") && (
          <Button
            variant="outline"
            className="rounded-xl border-blue-300 bg-blue-50 text-blue-900 shadow-sm hover:bg-blue-100 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-100 dark:hover:bg-blue-500/25"
            onClick={() => setShowAddDialog(true)}
            data-testid="button-add-member"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Member
          </Button>
        )}
      </div>

      {/* Stats */}
      <FactoryInsuranceSection
        insExpenseBalance={insExpenseBalance}
        insuranceExpenseAccount={insuranceExpenseAccount}
        stats={stats}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/80 p-3 shadow-sm dark:border-slate-700/70 dark:bg-[hsl(var(--factory-hue)_56%_12%)]/85">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <Input
            placeholder="Search by name, nationality, position..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 w-full rounded-xl border-slate-200 bg-slate-50 pl-10 dark:border-slate-600 dark:bg-slate-900/80"
            data-testid="input-search"
          />
        </div>
        <div className="flex items-center gap-2 rounded-xl px-2 py-1">
          <Switch
            id="show-inactive"
            checked={includeInactive}
            onCheckedChange={setIncludeInactive}
            data-testid="switch-show-inactive"
          />
          <Label htmlFor="show-inactive" className="text-sm cursor-pointer">
            Show inactive
          </Label>
        </div>
      </div>

      {/* Members Table — cosmetic treatment only; all member actions and data sources are unchanged. */}
      <FactoryInsuranceCardSection
        filteredMembers={filteredMembers}
        formatDisplayDate={formatDisplayDate}
        isError={isError}
        isLoading={isLoading}
        members={members}
        membersError={membersError}
        recordChanges={recordChanges}
        setDeleteMember={setDeleteMember}
        setEditMember={setEditMember}
        setStatementMember={setStatementMember}
        toggleMutation={toggleMutation}
      />

      {/* Member Statement Drawer */}
      {statementMember && <MemberStatementDrawer member={statementMember} onClose={() => setStatementMember(null)} />}

      <InsuranceImportDialog open={showImportDialog} onClose={() => setShowImportDialog(false)} />
      <InsuranceClearDialog
        open={showClearDialog}
        companyName={selectedCompany?.name}
        onClose={() => setShowClearDialog(false)}
      />

      {/* Add / Edit Member Dialog */}
      {(showAddDialog || editMember) && (
        <MemberFormDialog
          open={showAddDialog || !!editMember}
          onClose={() => {
            setShowAddDialog(false);
            setEditMember(null);
          }}
          existing={editMember}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteMember} onOpenChange={(v) => !v && setDeleteMember(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Member</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Permanently delete <span className="font-semibold text-foreground">{deleteMember?.name}</span>? This cannot
            be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteMember(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMember && deleteMutation.mutate(deleteMember.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extra Charges Dialog */}
      <FactoryInsuranceDialogSection
        ecAmount={ecAmount}
        ecCrId={ecCrId}
        ecCrOpen={ecCrOpen}
        ecCrRef={ecCrRef}
        ecCrSearch={ecCrSearch}
        ecDate={ecDate}
        ecDrId={ecDrId}
        ecDrOpen={ecDrOpen}
        ecDrRef={ecDrRef}
        ecDrSearch={ecDrSearch}
        ecNotes={ecNotes}
        extraChargesMutation={extraChargesMutation}
        ledgerAccounts={ledgerAccounts}
        setEcAmount={setEcAmount}
        setEcCrId={setEcCrId}
        setEcCrOpen={setEcCrOpen}
        setEcCrSearch={setEcCrSearch}
        setEcDate={setEcDate}
        setEcDrId={setEcDrId}
        setEcDrOpen={setEcDrOpen}
        setEcDrSearch={setEcDrSearch}
        setEcNotes={setEcNotes}
        setShowExtraCharges={setShowExtraCharges}
        showExtraCharges={showExtraCharges}
      />

      {/* Generate Entries Dialog */}
      <Dialog open={showGenDialog} onOpenChange={(v) => !v && setShowGenDialog(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Generate Insurance Entries</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Posts a journal voucher for all active members: Dr Insurance Expense / Cr each member's personal account.
              Members whose start date falls within the month are prorated.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Month</Label>
                <Select value={String(genMonth)} onValueChange={(v) => setGenMonth(parseInt(v))}>
                  <SelectTrigger data-testid="select-gen-month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Year</Label>
                <Select value={String(genYear)} onValueChange={(v) => setGenYear(parseInt(v))}>
                  <SelectTrigger data-testid="select-gen-year">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {YEARS.map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenDialog(false)} data-testid="button-cancel-gen">
              Cancel
            </Button>
            <Button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              data-testid="button-confirm-gen"
            >
              {generateMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
