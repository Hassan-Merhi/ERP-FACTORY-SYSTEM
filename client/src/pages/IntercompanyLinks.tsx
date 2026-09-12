import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, Pencil, Trash2, Users, ArrowRight } from "lucide-react";

interface ICLink {
  id: number;
  label: string | null;
  sourceCompanyId: number;
  sourceCompanyName: string;
  sourceLedgerAccountId: number;
  sourceLedgerName: string;
  destCompanyId: number;
  destCompanyName: string;
  destLedgerAccountId: number;
  destLedgerName: string;
  active: boolean;
  createdAt: string;
}

interface ICRecipient {
  id: number;
  userId: string;
  username: string | null;
}

interface Company {
  id: number;
  name: string;
}

interface LedgerAccount {
  id: number;
  name: string;
  companyId: number;
}

interface User {
  id: string;
  username: string;
}

const EMPTY_FORM = {
  label: "",
  sourceCompanyId: "",
  sourceLedgerAccountId: "",
  destCompanyId: "",
  destLedgerAccountId: "",
};

export default function IntercompanyLinks() {
  const [, _navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<ICLink | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [recipientUserIds, setRecipientUserIds] = useState<string[]>([]);

  const [recipientsDialogLink, setRecipientsDialogLink] = useState<ICLink | null>(null);
  const [recipientForm, setRecipientForm] = useState<string[]>([]);

  // Queries
  const { data: links = [], isLoading } = useQuery<ICLink[]>({
    queryKey: ["/api/intercompany-links"],
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  // Fetch accounts per selected company so cross-company picks always populate
  const { data: srcAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", "company", form.sourceCompanyId],
    queryFn: async () => {
      if (!form.sourceCompanyId) return [];
      const r = await fetch(`/api/ledger-accounts?companyId=${form.sourceCompanyId}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!form.sourceCompanyId,
  });

  const { data: dstAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", "company", form.destCompanyId],
    queryFn: async () => {
      if (!form.destCompanyId) return [];
      const r = await fetch(`/api/ledger-accounts?companyId=${form.destCompanyId}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!form.destCompanyId,
  });

  // Dest-company members for the create-dialog recipient picker
  const { data: createDialogMemberIds = [] } = useQuery<string[]>({
    queryKey: ["/api/companies", form.destCompanyId, "member-ids"],
    queryFn: async () => {
      if (!form.destCompanyId) return [];
      const r = await fetch(`/api/companies/${form.destCompanyId}/member-ids`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!form.destCompanyId && dialogOpen && !editingLink,
  });

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const r = await fetch("/api/users", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const { data: recipientsData = [] } = useQuery<ICRecipient[]>({
    queryKey: ["/api/intercompany-links", recipientsDialogLink?.id, "recipients"],
    queryFn: async () => {
      if (!recipientsDialogLink) return [];
      const r = await fetch(`/api/intercompany-links/${recipientsDialogLink.id}/recipients`, {
        credentials: "include",
      });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!recipientsDialogLink,
  });

  // Load user IDs that have a role in the dest company — constrains recipient dialog
  const { data: destCompanyMemberIds = [] } = useQuery<string[]>({
    queryKey: ["/api/companies", recipientsDialogLink?.destCompanyId, "member-ids"],
    queryFn: async () => {
      if (!recipientsDialogLink?.destCompanyId) return [];
      const r = await fetch(`/api/companies/${recipientsDialogLink.destCompanyId}/member-ids`, {
        credentials: "include",
      });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!recipientsDialogLink?.destCompanyId,
  });

  // Seed recipientForm once the query resolves for the open dialog
  useEffect(() => {
    if (recipientsDialogLink && recipientsData.length >= 0) {
      setRecipientForm(recipientsData.map((r) => r.userId));
    }
  }, [recipientsData, recipientsDialogLink]);

  // Mutations
  const createMutation = useMutation({
    mutationFn: (payload: {
      label: string | null;
      sourceCompanyId: number;
      sourceLedgerAccountId: number;
      destCompanyId: number;
      destLedgerAccountId: number;
      recipientUserIds?: string[];
    }) => apiRequest("POST", "/api/intercompany-links", payload),
    onSuccess: () => {
      toast({ title: "Link created" });
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-links"] });
      closeDialog();
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: number;
      payload: {
        label: string | null;
        sourceCompanyId: number;
        sourceLedgerAccountId: number;
        destCompanyId: number;
        destLedgerAccountId: number;
      };
    }) => apiRequest("PUT", `/api/intercompany-links/${id}`, payload),
    onSuccess: () => {
      toast({ title: "Link updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-links"] });
      closeDialog();
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/intercompany-links/${id}`),
    onSuccess: () => {
      toast({ title: "Link deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-links"] });
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiRequest("PUT", `/api/intercompany-links/${id}`, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/intercompany-links"] }),
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const saveRecipientsMutation = useMutation({
    mutationFn: ({ id, userIds }: { id: number; userIds: string[] }) =>
      apiRequest("PUT", `/api/intercompany-links/${id}`, { recipientUserIds: userIds }),
    onSuccess: () => {
      toast({ title: "Recipients saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-links"] });
      setRecipientsDialogLink(null);
    },
    onError: (err: ClientErrorLike) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  function openCreate() {
    setEditingLink(null);
    setForm(EMPTY_FORM);
    setRecipientUserIds([]);
    setDialogOpen(true);
  }

  function openEdit(link: ICLink) {
    setEditingLink(link);
    setForm({
      label: link.label || "",
      sourceCompanyId: String(link.sourceCompanyId),
      sourceLedgerAccountId: String(link.sourceLedgerAccountId),
      destCompanyId: String(link.destCompanyId),
      destLedgerAccountId: String(link.destLedgerAccountId),
    });
    setRecipientUserIds([]);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingLink(null);
    setForm(EMPTY_FORM);
  }

  function handleSave() {
    const basePayload = {
      label: form.label || null,
      sourceCompanyId: parseInt(form.sourceCompanyId),
      sourceLedgerAccountId: parseInt(form.sourceLedgerAccountId),
      destCompanyId: parseInt(form.destCompanyId),
      destLedgerAccountId: parseInt(form.destLedgerAccountId),
    };
    if (editingLink) {
      // Do NOT include recipientUserIds on edit — recipients are managed separately
      // via the dedicated Manage Recipients dialog to avoid accidentally wiping them
      updateMutation.mutate({ id: editingLink.id, payload: basePayload });
    } else {
      createMutation.mutate({ ...basePayload, recipientUserIds });
    }
  }

  function openRecipients(link: ICLink) {
    setRecipientsDialogLink(link);
    setRecipientForm([]); // will be seeded by useEffect once query resolves
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const canSave = form.sourceCompanyId && form.sourceLedgerAccountId && form.destCompanyId && form.destLedgerAccountId;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => window.history.back()} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Intercompany Account Links</h1>
          <p className="text-sm text-muted-foreground">
            Define which source ledger accounts trigger payment notifications in other companies
          </p>
        </div>
        <Button onClick={openCreate} className="ml-auto" data-testid="button-create-link">
          <Plus className="h-4 w-4 mr-1.5" />
          New Link
        </Button>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
          ) : links.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground text-sm">
              No intercompany links configured yet. Click <strong>New Link</strong> to add one.
            </div>
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
                          onClick={() => {
                            if (confirm("Delete this link?")) deleteMutation.mutate(link.id);
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

            <div className="grid grid-cols-2 gap-3">
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

            <div className="grid grid-cols-2 gap-3">
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
