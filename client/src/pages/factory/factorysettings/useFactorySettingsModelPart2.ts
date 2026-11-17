// Extracted from ./useFactorySettingsModel.ts to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { FactorySettingsData, Location, WaChat } from "./types";
import { defaultSettings } from "./utils";
import { type FactoryCompanyUiSettings, factoryRenameDefaults } from "@shared/factoryUiDefaults";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useFactorySettingsModelPart1 } from "./useFactorySettingsModelPart1";

export function useFactorySettingsModelPart2({
  attendanceWaPickerOpen,
  attendanceWaSearch,
  prodWaPickerOpen,
  prodWaSearch,
  selectedCompany,
  setAttendanceWaGroupId,
  setAttendanceWaPickerOpen,
  setAttendanceWaSearch,
  setCodePrefix,
  setFindStr,
  setProdWaGroupId,
  setProdWaPickerOpen,
  setRenamePreview,
  setReplaceStr,
  setSettings,
  setWeeklyWaGroupId,
  setWeeklyWaPickerOpen,
  settings,
  toast,
  weeklyWaPickerOpen,
  weeklyWaSearch,
}: Pick<
  Awaited<ReturnType<typeof useFactorySettingsModelPart1>>,
  | "attendanceWaPickerOpen"
  | "attendanceWaSearch"
  | "prodWaPickerOpen"
  | "prodWaSearch"
  | "selectedCompany"
  | "setAttendanceWaGroupId"
  | "setAttendanceWaPickerOpen"
  | "setAttendanceWaSearch"
  | "setCodePrefix"
  | "setFindStr"
  | "setProdWaGroupId"
  | "setProdWaPickerOpen"
  | "setRenamePreview"
  | "setReplaceStr"
  | "setSettings"
  | "setWeeklyWaGroupId"
  | "setWeeklyWaPickerOpen"
  | "settings"
  | "toast"
  | "weeklyWaPickerOpen"
  | "weeklyWaSearch"
>) {
  const { data: locations } = useQuery<Location[]>({
    queryKey: companyQueryKey("/api/locations", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const { data, isLoading } = useQuery<FactorySettingsData & FactoryCompanyUiSettings>({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  useEffect(() => {
    // Never carry editable rename input or preview from one company to another.
    const defaults = factoryRenameDefaults();
    setCodePrefix(defaults.codePrefix);
    setFindStr(defaults.find);
    setReplaceStr(defaults.replace);
    setRenamePreview(null);
  }, [selectedCompany?.id, setCodePrefix, setFindStr, setRenamePreview, setReplaceStr]);

  useEffect(() => {
    if (data) {
      // Select company-specific rename UI default only if the existing settings API provides it.
      // Never write a legacy default to stock codes or backfill database settings.
      setCodePrefix(factoryRenameDefaults(data).codePrefix);
      setFindStr(factoryRenameDefaults(data).find);
      setReplaceStr(factoryRenameDefaults(data).replace);
      setRenamePreview(null);
      // The automatic allocation flag has its own protected editor and must
      // never leak into the generic bulk settings Save payload.
      const { automaticPriorityPrintingEnabled: _automaticMode, ...bulkSettings } = data as FactorySettingsData & {
        automaticPriorityPrintingEnabled?: boolean;
      };
      setSettings({ ...defaultSettings, ...bulkSettings });
      const waGroupId = (data as FactorySettingsData & { productionWorkerMatrixWhatsappGroupId?: string | null })
        .productionWorkerMatrixWhatsappGroupId;
      setProdWaGroupId(waGroupId ?? "");
    }
  }, [data, setCodePrefix, setFindStr, setProdWaGroupId, setRenamePreview, setReplaceStr, setSettings]);

  const { data: waChats = [], isLoading: waChatsLoading } = useQuery<WaChat[]>({
    queryKey: companyQueryKey("/api/whatsapp/chats/pos", selectedCompany?.id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/whatsapp/chats/pos");
      if (!res.ok) throw new Error("Failed to load chats");
      return res.json();
    },
    enabled: prodWaPickerOpen && Boolean(selectedCompany?.id),
    staleTime: 60_000,
    retry: false,
  });

  const { data: weeklyWaChats = [], isLoading: weeklyWaChatsLoading } = useQuery<WaChat[]>({
    queryKey: companyQueryKey("/api/whatsapp/chats", selectedCompany?.id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/whatsapp/chats");
      if (!res.ok) throw new Error("Failed to load chats");
      return res.json();
    },
    enabled: weeklyWaPickerOpen && Boolean(selectedCompany?.id),
    staleTime: 60_000,
    retry: false,
  });

  const { data: attendanceWaSettings } = useQuery<{ attendanceWhatsappGroupId?: string | null }>({
    queryKey: companyQueryKey("/api/factory/settings?scope=attendance", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/settings?scope=attendance");
      if (!res.ok) throw new Error("Failed to load Attendance WhatsApp settings");
      return res.json();
    },
    staleTime: 30_000,
  });

  const { data: attendanceWaChats = [], isLoading: attendanceWaChatsLoading } = useQuery<WaChat[]>({
    queryKey: companyQueryKey("/api/whatsapp/chats", selectedCompany?.id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/whatsapp/chats");
      if (!res.ok) throw new Error("Failed to load chats");
      return res.json();
    },
    enabled: attendanceWaPickerOpen && Boolean(selectedCompany?.id),
    staleTime: 60_000,
    retry: false,
  });

  const { data: weeklyWaSettings } = useQuery<{ groupChatId: string; hasCredentials: boolean }>({
    queryKey: companyQueryKey("/api/factory/weekly-report-wa-settings", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  useEffect(() => {
    if (weeklyWaSettings?.groupChatId) setWeeklyWaGroupId(weeklyWaSettings.groupChatId);
  }, [weeklyWaSettings, setWeeklyWaGroupId]);

  useEffect(() => {
    setAttendanceWaGroupId(attendanceWaSettings?.attendanceWhatsappGroupId ?? "");
  }, [attendanceWaSettings, setAttendanceWaGroupId]);

  const saveWeeklyWaGroupMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await factoryApiRequest("PATCH", "/api/factory/weekly-report-wa-settings", { groupChatId: chatId });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/weekly-report-wa-settings"] });
      setWeeklyWaPickerOpen(false);
      toast({ title: "Saved", description: "Weekly report WhatsApp group updated." });
    },
    onError: (error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const filteredWeeklyWaChats = weeklyWaChats.filter(
    (chat) => !weeklyWaSearch || chat.name?.toLowerCase().includes(weeklyWaSearch.toLowerCase())
  );

  const saveAttendanceWaGroupMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await factoryApiRequest("PUT", "/api/factory/settings?scope=attendance", {
        attendanceWhatsappGroupId: chatId,
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.message || "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/settings?scope=attendance"] });
      setAttendanceWaPickerOpen(false);
      setAttendanceWaSearch("");
      toast({ title: "Saved", description: "Attendance WhatsApp group updated." });
    },
    onError: (error: Error & { _handledGlobally?: boolean }) => {
      if (error?._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const filteredAttendanceWaChats = attendanceWaChats.filter((chat) => {
    const isGroup = chat.id.endsWith("@g.us") || chat.type?.toLowerCase().includes("group");
    const matches = searchAny(attendanceWaSearch, chat.name, chat.id);
    return isGroup && matches;
  });

  const saveProdWaGroupMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await factoryApiRequest("PUT", "/api/factory/settings", {
        productionWorkerMatrixWhatsappGroupId: chatId,
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/settings"] });
      setProdWaPickerOpen(false);
      toast({ title: "Saved", description: "Production WhatsApp group updated." });
    },
    onError: (error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const filteredWaChats = waChats.filter(
    (chat) => !prodWaSearch || chat.name?.toLowerCase().includes(prodWaSearch.toLowerCase())
  );

  const mutation = useMutation({
    mutationFn: async (updated: FactorySettingsData) => {
      const res = await factoryApiRequest("PUT", "/api/factory/settings", updated);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/settings"] });
      toast({ title: "Settings saved", description: "Factory settings have been updated successfully." });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const handleToggle = (key: keyof FactorySettingsData) => {
    setSettings((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  const handleNumberChange = (key: keyof FactorySettingsData, value: string) => {
    setSettings((previous) => ({ ...previous, [key]: parseFloat(value) || 0 }));
  };

  const handleSave = () => mutation.mutate(settings);
  return {
    attendanceWaChats,
    attendanceWaChatsLoading,
    filteredAttendanceWaChats,
    filteredWaChats,
    filteredWeeklyWaChats,
    handleNumberChange,
    handleSave,
    handleToggle,
    isLoading,
    locations,
    mutation,
    saveAttendanceWaGroupMutation,
    saveProdWaGroupMutation,
    saveWeeklyWaGroupMutation,
    waChats,
    waChatsLoading,
    weeklyWaChats,
    weeklyWaChatsLoading,
  };
}
