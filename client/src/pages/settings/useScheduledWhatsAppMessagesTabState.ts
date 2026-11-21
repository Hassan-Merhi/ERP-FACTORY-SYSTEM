// Extracted from ./ScheduledWhatsAppMessagesTab.tsx
import { useEffect, useState } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ClientErrorLike } from "@/lib/clientError";
import { blankForm, type Schedule, type Group, type Delivery, type Form } from "./ScheduledWhatsAppMessagesTabHelpers";

export function useScheduledWhatsAppMessagesTabState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blankForm);
  const [editorOpen, setEditorOpen] = useState(false);
  const {
    data: schedules = [],
    isLoading: loading,
    isError: schedulesError,
    refetch: refetchSchedules,
  } = useQuery<Schedule[]>({
    queryKey: ["/api/whatsapp/message-schedules", companyId],
    enabled: !!companyId,
  });
  const { data: whatsappSettings } = useQuery<{ enabled: boolean; hasCredentials: boolean }>({
    queryKey: ["/api/whatsapp/settings"],
    enabled: !!companyId,
  });
  const { data: recipients = [] } = useQuery<Group[]>({
    queryKey: ["/api/whatsapp/recipients", companyId],
    enabled: !!companyId,
  });
  const { data: history = [] } = useQuery<Delivery[]>({
    queryKey: ["/api/whatsapp/message-schedules/history", companyId],
    enabled: !!companyId,
    refetchInterval: 60000,
  });
  useEffect(() => {
    setEditorOpen(false);
    setEditingId(null);
    setForm(blankForm());
  }, [companyId]);

  const groups = recipients.filter((r) => r.active && r.isGroup);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/message-schedules"] });
    queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/message-schedules/history"] });
  };
  const save = useMutation({
    mutationFn: async (payload: { id?: string; values: Form }) =>
      apiRequest(
        payload.id ? "PUT" : "POST",
        payload.id ? "/api/whatsapp/message-schedules/" + payload.id : "/api/whatsapp/message-schedules",
        payload.values
      ),
    onSuccess: () => {
      refresh();
      setEditorOpen(false);
      setEditingId(null);
      setForm(blankForm());
      toast({ title: "WhatsApp message schedule saved" });
    },
    onError: (error: ClientErrorLike) =>
      toast({ title: "Unable to save", description: error.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", "/api/whatsapp/message-schedules/" + id),
    onSuccess: () => {
      refresh();
      toast({ title: "Schedule deleted" });
    },
    onError: (error: ClientErrorLike) =>
      toast({ title: "Unable to delete", description: error.message, variant: "destructive" }),
  });

  const beginNew = () => {
    setForm(blankForm());
    setEditingId(null);
    setEditorOpen(true);
  };
  const beginEdit = (item: Schedule) => {
    setEditingId(item.id);
    setForm({
      title: item.title,
      message: item.message,
      timezone: item.timezone,
      weeklyTimes: { ...item.weeklyTimes },
      startDate: item.startDate,
      endDate: item.endDate,
      enabled: item.enabled,
      recipientIds: [...item.recipientIds],
    });
    setEditorOpen(true);
  };
  const setField = <K extends keyof Form>(key: K, value: Form[K]) => setForm((old) => ({ ...old, [key]: value }));
  const submit = () => {
    if (!form.title.trim() || !form.message.trim()) {
      toast({ title: "Enter a title and message", variant: "destructive" });
      return;
    }
    if (!Object.keys(form.weeklyTimes).length || !form.recipientIds.length) {
      toast({ title: "Select at least one day and WhatsApp group", variant: "destructive" });
      return;
    }
    save.mutate({ id: editingId || undefined, values: form });
  };
  return {
    companyId,
    editingId,
    form,
    setForm,
    editorOpen,
    setEditorOpen,
    loading,
    schedulesError,
    schedules,
    refetchSchedules,
    whatsappSettings,
    recipients,
    history,
    groups,
    save,
    remove,
    beginNew,
    beginEdit,
    setField,
    submit,
  };
}
