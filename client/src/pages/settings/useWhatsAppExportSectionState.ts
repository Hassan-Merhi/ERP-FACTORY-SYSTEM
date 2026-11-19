// Extracted from ./WhatsAppExportSection.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { WaSettings, Recipient, GreenChat, InstanceState } from "./WhatsAppExportSectionTypes";

export function useWhatsAppExportSectionState() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [instanceId, setInstanceId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [newChatId, setNewChatId] = useState("");
  const [newName, setNewName] = useState("");
  const [checkStateEnabled, setCheckStateEnabled] = useState(false);

  const { data: settings } = useQuery<WaSettings>({
    queryKey: ["/api/whatsapp/settings"],
    enabled: expanded,
  });

  const {
    data: instanceStateData,
    isLoading: instanceStateLoading,
    refetch: refetchInstanceState,
  } = useQuery<{ state: InstanceState }>({
    queryKey: ["/api/whatsapp/instance-state/main"],
    enabled: checkStateEnabled && expanded,
    staleTime: 10_000,
    retry: false,
  });

  const {
    data: recipients = [],
    isLoading: loadingRecipients,
    isError: recipientsError,
    refetch: refetchRecipients,
  } = useQuery<Recipient[]>({
    queryKey: ["/api/whatsapp/recipients"],
    enabled: expanded,
  });

  const {
    data: chats = [],
    isLoading: loadingChats,
    refetch: fetchChats,
  } = useQuery<GreenChat[]>({
    queryKey: ["/api/whatsapp/chats"],
    enabled: false,
  });

  const saveSettings = useMutation({
    mutationFn: () =>
      apiRequest("PUT", "/api/whatsapp/settings", {
        instanceId,
        apiToken,
        enabled: settings?.enabled ?? false,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/settings"] });
      toast({ title: "WhatsApp credentials saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const toggleEnabled = useMutation({
    mutationFn: (value: boolean) =>
      apiRequest("PUT", "/api/whatsapp/settings", {
        instanceId: settings?.instanceId ?? "",
        apiToken: "••••••",
        enabled: value,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/settings"] }),
    onError: (e: ClientErrorLike) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const addRecipient = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/recipients", { chatId: newChatId, name: newName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] });
      setNewChatId("");
      setNewName("");
      toast({ title: "Recipient added" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const addFromChat = useMutation({
    mutationFn: (chat: GreenChat) =>
      apiRequest("POST", "/api/whatsapp/recipients", { chatId: chat.id, name: chat.name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] });
      toast({ title: "Added from group list" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiRequest("PUT", `/api/whatsapp/recipients/${id}`, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] }),
    onError: (e: ClientErrorLike) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const deleteRecipient = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/whatsapp/recipients/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/recipients"] });
      toast({ title: "Recipient removed" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const handleFetchChats = async () => {
    setShowGroupPicker(true);
    await fetchChats();
  };

  const groups = chats.filter((c) => c.type === "group" || c.id.endsWith("@g.us"));
  return {
    setExpanded,
    expanded,
    instanceId,
    setInstanceId,
    apiToken,
    setApiToken,
    showGroupPicker,
    newChatId,
    setNewChatId,
    newName,
    setNewName,
    setCheckStateEnabled,
    settings,
    refetchInstanceState,
    instanceStateLoading,
    instanceStateData,
    recipients,
    loadingRecipients,
    recipientsError,
    refetchRecipients,
    loadingChats,
    saveSettings,
    toggleEnabled,
    addRecipient,
    addFromChat,
    toggleActive,
    deleteRecipient,
    handleFetchChats,
    groups,
  };
}
