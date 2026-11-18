import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, X } from "lucide-react";
import { useFactoryContactsState } from "./useFactoryContactsState";
import { FactoryContactsSection } from "./FactoryContactsSection";

export default function FactoryContacts() {
  const {
    addNumber,
    canCreateContact,
    contactFilter,
    deleteMutation,
    deleteTarget,
    dialogOpen,
    editingContact,
    filtered,
    form,
    formId,
    handleSubmit,
    isLoading,
    openEdit,
    openNew,
    orderedContacts,
    pageSize,
    pages,
    prefs,
    queryClient,
    recordChanges,
    removeNumber,
    safePage,
    saveMutation,
    saving,
    search,
    setContactFilter,
    setDeleteTarget,
    setDialogOpen,
    setForm,
    setNumber,
    setPage,
    setPrefs,
    setSearch,
    show,
    summaryCards,
    visibility,
    visibleContacts,
  } = useFactoryContactsState();

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-br from-indigo-100/75 via-blue-50/30 to-transparent dark:from-blue-700/15 dark:via-indigo-800/10 dark:to-transparent"
      />
      <FactoryContactsSection
        canCreateContact={canCreateContact}
        contactFilter={contactFilter}
        filtered={filtered}
        isLoading={isLoading}
        openEdit={openEdit}
        openNew={openNew}
        orderedContacts={orderedContacts}
        pageSize={pageSize}
        pages={pages}
        prefs={prefs}
        queryClient={queryClient}
        recordChanges={recordChanges}
        safePage={safePage}
        search={search}
        setContactFilter={setContactFilter}
        setDeleteTarget={setDeleteTarget}
        setPage={setPage}
        setPrefs={setPrefs}
        setSearch={setSearch}
        show={show}
        summaryCards={summaryCards}
        visibility={visibility}
        visibleContacts={visibleContacts}
      />

      {/* Add / Edit Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(nextOpen) => {
          if (saveMutation.isPending || saving) return;
          setDialogOpen(nextOpen);
        }}
      >
        <DialogContent className="max-w-md" aria-busy={saveMutation.isPending || saving}>
          <DialogHeader>
            <DialogTitle>{editingContact ? "Edit Contact" : "Add Contact"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-name`}>Name *</Label>
              <Input
                id={`${formId}-name`}
                placeholder="e.g. Ahmed Karimi"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-role`}>Role / Purpose</Label>
              <Input
                id={`${formId}-role`}
                placeholder="e.g. Electrician, Plumber, Driver…"
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              />
            </div>

            <div className="space-y-2" role="group" aria-label="Phone Numbers">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Phone Numbers</span>
                <Button size="sm" variant="ghost" onClick={addNumber} type="button">
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>
              {form.numbers.map((n, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label={`Phone ${i + 1} label`}
                    placeholder="Label (e.g. Mobile)"
                    value={n.label}
                    onChange={(e) => setNumber(i, "label", e.target.value)}
                    className="w-28 shrink-0 text-sm"
                  />
                  <Input
                    aria-label={`Phone ${i + 1} number`}
                    placeholder="Number"
                    value={n.number}
                    onChange={(e) => setNumber(i, "number", e.target.value)}
                    className="font-mono text-sm"
                  />
                  {form.numbers.length > 1 && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 h-8 w-8 text-muted-foreground"
                      onClick={() => removeNumber(i)}
                      aria-label={`Remove phone ${i + 1}`}
                      type="button"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-notes`}>Notes</Label>
              <Textarea
                id={`${formId}-notes`}
                placeholder="Anything extra — hours, location, rates…"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
              />
            </div>
          </div>

          {saveMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              Contact could not be saved. Please review the fields and try again.
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saveMutation.isPending || saving}>
              Cancel
            </Button>
            <FormSubmitButton
              type="button"
              onClick={handleSubmit}
              pending={saveMutation.isPending || saving}
              pendingLabel="Saving…"
            >
              {editingContact ? "Save Changes" : "Add Contact"}
            </FormSubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleteTarget(null);
        }}
        title="Delete Contact"
        tone="destructive"
        description={
          <>
            Remove <strong>{deleteTarget?.name}</strong> from your contacts? This cannot be undone.
          </>
        }
        confirmText="Delete"
        loading={deleteMutation.isPending}
        onConfirm={async () => {
          if (deleteTarget) await deleteMutation.mutateAsync(deleteTarget.id);
        }}
      />
    </div>
  );
}
