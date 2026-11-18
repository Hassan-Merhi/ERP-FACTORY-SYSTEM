import { confirmAction } from "@/components/ConfirmHost";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Plus, Pencil, Trash2, Users } from "lucide-react";
import { useIntercompanyLinksState } from "./useIntercompanyLinksState";
import { IntercompanyLinksDialogSection } from "./IntercompanyLinksDialogSection";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";

export default function IntercompanyLinks() {
  const {
    refetch,
    isError,
    allUsers,
    canSave,
    closeDialog,
    companies,
    createDialogMemberIds,
    deleteMutation,
    destCompanyMemberIds,
    dialogOpen,
    dstAccounts,
    editingLink,
    form,
    handleSave,
    isLoading,
    isSaving,
    links,
    openCreate,
    openEdit,
    openRecipients,
    recipientForm,
    recipientUserIds,
    recipientsData,
    recipientsDialogLink,
    saveRecipientsMutation,
    setForm,
    setRecipientForm,
    setRecipientUserIds,
    setRecipientsDialogLink,
    srcAccounts,
    toggleActiveMutation,
  } = useIntercompanyLinksState();

  return (
    <div className="space-y-4 max-w-5xl mx-auto sm:p-6">
      {/* Header */}
      <PageHeader
        title="Intercompany Account Links"
        subtitle="Define which source ledger accounts trigger payment notifications in other companies"
        onBack={() => window.history.back()}
      >
        <Button onClick={openCreate} data-testid="button-create-link">
          <Plus className="h-4 w-4 mr-1.5" />
          New Link
        </Button>
      </PageHeader>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <LoadingState className="m-4 py-12" />
          ) : isError && links.length === 0 ? (
            <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="m-4 py-12" />
          ) : links.length === 0 ? (
            <EmptyState
              title="No intercompany links configured yet."
              description="Click New Link to add one."
              className="m-4 py-12"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Source (triggers on)</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="w-32">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map((link) => (
                  <TableRow key={link.id} data-testid={`row-link-${link.id}`}>
                    <TableCell className="font-medium">
                      {link.label || <span className="text-muted-foreground text-xs">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        <p className="font-medium">{link.sourceCompanyName}</p>
                        <p className="text-muted-foreground">{link.sourceLedgerName}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        <p className="font-medium">{link.destCompanyName}</p>
                        <p className="text-muted-foreground">{link.destLedgerName}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={link.active}
                        onCheckedChange={(checked) => toggleActiveMutation.mutate({ id: link.id, active: checked })}
                        data-testid={`switch-active-${link.id}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => openRecipients(link)}
                          title="Manage recipients"
                          data-testid={`button-recipients-${link.id}`}
                        >
                          <Users className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => openEdit(link)}
                          data-testid={`button-edit-${link.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={async () => {
                            if (await confirmAction({ title: "Delete this link?", tone: "destructive" }))
                              deleteMutation.mutate(link.id);
                          }}
                          data-testid={`button-delete-${link.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      <IntercompanyLinksDialogSection
        allUsers={allUsers}
        canSave={canSave}
        closeDialog={closeDialog}
        companies={companies}
        createDialogMemberIds={createDialogMemberIds}
        dialogOpen={dialogOpen}
        dstAccounts={dstAccounts}
        editingLink={editingLink}
        form={form}
        handleSave={handleSave}
        isSaving={isSaving}
        recipientUserIds={recipientUserIds}
        setForm={setForm}
        setRecipientUserIds={setRecipientUserIds}
        srcAccounts={srcAccounts}
      />

      {/* Recipients Dialog */}
      <Dialog
        open={!!recipientsDialogLink}
        onOpenChange={(open) => {
          if (!open) setRecipientsDialogLink(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Manage Recipients</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-xs text-muted-foreground">
              Select users in <strong>{recipientsDialogLink?.destCompanyName}</strong> who should receive notifications
              for this link.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {allUsers
                .filter((u) => destCompanyMemberIds.includes(u.id))
                .map((u) => {
                  const selected = recipientForm.includes(u.id);
                  return (
                    <Badge
                      key={u.id}
                      variant={selected ? "default" : "outline"}
                      className="cursor-pointer select-none"
                      onClick={() => {
                        setRecipientForm(
                          selected ? recipientForm.filter((id) => id !== u.id) : [...recipientForm, u.id]
                        );
                      }}
                      data-testid={`badge-recipient-${u.id}`}
                    >
                      {u.username}
                    </Badge>
                  );
                })}
              {destCompanyMemberIds.length === 0 && (
                <p className="text-xs text-muted-foreground">No users found for this company.</p>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Current: {recipientsData.map((r) => r.username || r.userId).join(", ") || "none"}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecipientsDialogLink(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!recipientsDialogLink) return;
                saveRecipientsMutation.mutate({ id: recipientsDialogLink.id, userIds: recipientForm });
              }}
              disabled={saveRecipientsMutation.isPending}
              data-testid="button-save-recipients"
            >
              {saveRecipientsMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
