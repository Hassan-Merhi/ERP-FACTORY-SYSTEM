// Extracted from ./IntercompanyLinks.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  EMPTY_FORM,
  type Company,
  type ICLink,
  type ICRecipient,
  type LedgerAccount,
  type User,
} from "./IntercompanyLinksTypes";

export function useIntercompanyLinksState() {
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
  return {
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
  };
}
