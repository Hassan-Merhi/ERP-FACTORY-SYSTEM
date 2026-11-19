// Extracted from ./ContainersWhatsAppSection.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ContainersWaSettings, GreenChat } from "./ContainersWhatsAppSectionTypes";

export function useContainersWhatsAppSectionState() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [groupChatId, setGroupChatId] = useState("");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleHour, setScheduleHour] = useState(8);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chats, setChats] = useState<GreenChat[]>([]);

  const { data: settings, isLoading } = useQuery<ContainersWaSettings>({
    queryKey: ["/api/git/containers-wa-settings"],
    enabled: expanded,
  });

  useEffect(() => {
    if (settings) {
      setGroupChatId(settings.groupChatId);
      setScheduleEnabled(settings.scheduleEnabled);
      setScheduleHour(settings.scheduleHour);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", "/api/git/containers-wa-settings", {
        groupChatId,
        scheduleEnabled,
        scheduleHour,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/git/containers-wa-settings"] });
      toast({ title: "Containers WhatsApp settings saved." });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const testSendMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/git/send-containers-whatsapp", {}),
    onSuccess: () => toast({ title: "Sent", description: "Container report (PDF) sent to the configured group." }),
    onError: (e: ClientErrorLike) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });
  return {
    toast,
    setExpanded,
    expanded,
    groupChatId,
    setGroupChatId,
    scheduleEnabled,
    setScheduleEnabled,
    scheduleHour,
    setScheduleHour,
    setShowGroupPicker,
    showGroupPicker,
    setChatsLoading,
    chatsLoading,
    setChats,
    chats,
    settings,
    isLoading,
    saveMutation,
    testSendMutation,
  };
}
