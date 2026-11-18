// Extracted from ./IntercompanyLinks.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowRight } from "lucide-react";
import { useIntercompanyLinksState } from "./useIntercompanyLinksState";

export function IntercompanyLinksDialogSection({
  allUsers,
  canSave,
  closeDialog,
  companies,
  createDialogMemberIds,
  dialogOpen,
  dstAccounts,
  editingLink,
  form,
  handleSave,
  isSaving,
  recipientUserIds,
  setForm,
  setRecipientUserIds,
  srcAccounts,
}: Pick<
  ReturnType<typeof useIntercompanyLinksState>,
  | "allUsers"
  | "canSave"
  | "closeDialog"
  | "companies"
  | "createDialogMemberIds"
  | "dialogOpen"
  | "dstAccounts"
  | "editingLink"
  | "form"
  | "handleSave"
  | "isSaving"
  | "recipientUserIds"
  | "setForm"
  | "setRecipientUserIds"
  | "srcAccounts"
>) {
  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingLink ? "Edit Link" : "New Intercompany Link"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Label (optional)</Label>
            <Input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Lubumbashi → Factory payments"
              data-testid="input-link-label"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Source company</Label>
              <Select
                value={form.sourceCompanyId}
                onValueChange={(v) => setForm((f) => ({ ...f, sourceCompanyId: v, sourceLedgerAccountId: "" }))}
              >
                <SelectTrigger data-testid="select-source-company">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Source ledger account</Label>
              <Select
                value={form.sourceLedgerAccountId}
                onValueChange={(v) => setForm((f) => ({ ...f, sourceLedgerAccountId: v }))}
                disabled={!form.sourceCompanyId}
              >
                <SelectTrigger data-testid="select-source-account">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {srcAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-center">
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <div className="h-px w-8 bg-border" />
              <ArrowRight className="h-3.5 w-3.5" />
              <span>notifies</span>
              <ArrowRight className="h-3.5 w-3.5" />
              <div className="h-px w-8 bg-border" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Destination company</Label>
              <Select
                value={form.destCompanyId}
                onValueChange={(v) => setForm((f) => ({ ...f, destCompanyId: v, destLedgerAccountId: "" }))}
              >
                <SelectTrigger data-testid="select-dest-company">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>IC account (credit side)</Label>
              <Select
                value={form.destLedgerAccountId}
                onValueChange={(v) => setForm((f) => ({ ...f, destLedgerAccountId: v }))}
                disabled={!form.destCompanyId}
              >
                <SelectTrigger data-testid="select-dest-account">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {dstAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!editingLink && (
            <div className="space-y-1.5">
              <Label>Recipients (who gets notified)</Label>
              {!form.destCompanyId && (
                <p className="text-xs text-muted-foreground">Select a destination company first.</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {allUsers
                  .filter((u) => !form.destCompanyId || createDialogMemberIds.includes(u.id))
                  .map((u) => {
                    const selected = recipientUserIds.includes(u.id);
                    return (
                      <Badge
                        key={u.id}
                        variant={selected ? "default" : "outline"}
                        className="cursor-pointer select-none"
                        onClick={() =>
                          setRecipientUserIds((ids) => (selected ? ids.filter((id) => id !== u.id) : [...ids, u.id]))
                        }
                        data-testid={`badge-user-${u.id}`}
                      >
                        {u.username}
                      </Badge>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || isSaving} data-testid="button-save-link">
            {isSaving ? "Saving…" : editingLink ? "Save Changes" : "Create Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
