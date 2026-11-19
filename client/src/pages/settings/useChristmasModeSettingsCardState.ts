// Extracted from ./ChristmasModeSettingsCard.tsx
import { useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  useChristmasModeConfiguration,
  defaultChristmasVisuals,
  type ChristmasVisualSettings,
} from "@/hooks/useChristmasMode";

type ChristmasDraft = { enabled: boolean; userIds: string[]; visuals: ChristmasVisualSettings };

export function useChristmasModeSettingsCardState() {
  const { toast } = useToast();
  const { configQuery, saveConfig } = useChristmasModeConfiguration();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<ChristmasDraft | null>(null);

  const config = configQuery.data;
  const enabled = draft?.enabled ?? config?.enabled ?? false;
  const selectedIds = useMemo(() => draft?.userIds ?? config?.userIds ?? [], [draft?.userIds, config?.userIds]);
  const visuals = draft?.visuals ?? config?.visuals ?? defaultChristmasVisuals;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const filteredUsers = useMemo(
    () => (config?.users ?? []).filter((user) => user.username.toLowerCase().includes(search.trim().toLowerCase())),
    [config?.users, search]
  );
  const changed =
    draft !== null &&
    (draft.enabled !== config?.enabled ||
      draft.userIds.length !== (config?.userIds.length ?? 0) ||
      draft.userIds.some((id) => !config?.userIds.includes(id)) ||
      JSON.stringify(draft.visuals) !== JSON.stringify(config?.visuals ?? defaultChristmasVisuals));
  const loading = configQuery.isLoading;
  const saving = saveConfig.isPending;

  const edit = (next: Partial<ChristmasDraft>) => {
    setDraft((previous) => ({
      enabled: next.enabled ?? previous?.enabled ?? config?.enabled ?? false,
      userIds: next.userIds ?? previous?.userIds ?? config?.userIds ?? [],
      visuals: next.visuals ?? previous?.visuals ?? config?.visuals ?? defaultChristmasVisuals,
    }));
  };

  const toggleUser = (userId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(userId);
    else next.delete(userId);
    edit({ userIds: [...next] });
  };

  const save = () => {
    saveConfig.mutate(
      { enabled, userIds: selectedIds, visuals },
      {
        onSuccess: () => {
          setDraft(null);
          toast({
            title: "Christmas Mode access saved",
            description: "Only selected users will receive the effects when the master switch is ON.",
          });
        },
        onError: (error) =>
          toast({
            title: "Unable to update Christmas Mode",
            description: error.message || "Your changes were not saved.",
            variant: "destructive",
          }),
      }
    );
  };
  return {
    configQuery,
    search,
    setSearch,
    enabled,
    selectedIds,
    visuals,
    selectedSet,
    filteredUsers,
    changed,
    loading,
    saving,
    edit,
    toggleUser,
    save,
  };
}
