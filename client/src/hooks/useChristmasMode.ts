import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

const CHRISTMAS_MODE_API = "/api/seasonal/christmas-mode";
export const christmasModeQueryKey = [CHRISTMAS_MODE_API] as const;

export type ChristmasEffectKey = "snowfall" | "santa" | "garlands" | "countdown" | "gifts" | "ambient";
export type ChristmasVisualSettings = {
  intensity: "subtle" | "balanced" | "full";
  effects: Record<ChristmasEffectKey, boolean>;
};
export type ChristmasIntensity = ChristmasVisualSettings["intensity"];
export const defaultChristmasVisuals: ChristmasVisualSettings = {
  intensity: "balanced",
  effects: { snowfall: true, santa: true, garlands: true, countdown: true, gifts: true, ambient: true },
};

export type ChristmasModeSetting = {
  enabled: boolean;
  available?: boolean;
  preferenceEnabled?: boolean;
  visuals?: ChristmasVisualSettings | null;
};

/**
 * Per-user effective Christmas Mode flag (never exposes who else has access).
 * Every authenticated shell reads this to decide whether effects are visible.
 */
export function useChristmasMode() {
  const settingQuery = useQuery<ChristmasModeSetting>({
    queryKey: christmasModeQueryKey,
    queryFn: async () => {
      const response = await apiRequest("GET", CHRISTMAS_MODE_API);
      return (await response.json()) as ChristmasModeSetting;
    },
    staleTime: 15_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: () => (typeof document === "undefined" || document.visibilityState === "visible" ? 30_000 : false),
  });

  const updateSetting = useMutation<ChristmasModeSetting, Error, boolean>({
    mutationFn: async (enabled) => {
      const response = await apiRequest("PUT", CHRISTMAS_MODE_API, { enabled });
      return (await response.json()) as ChristmasModeSetting;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(christmasModeQueryKey, result);
      void queryClient.invalidateQueries({ queryKey: christmasModeQueryKey });
    },
  });

  const updatePersonalPreference = useMutation<ChristmasModeSetting, Error, boolean>({
    mutationFn: async (enabled) => {
      const response = await apiRequest("PUT", `${CHRISTMAS_MODE_API}/preference`, { enabled });
      return (await response.json()) as ChristmasModeSetting;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(christmasModeQueryKey, result);
      void queryClient.invalidateQueries({ queryKey: christmasModeQueryKey });
    },
  });

  return { settingQuery, updateSetting, updatePersonalPreference };
}

const CHRISTMAS_MODE_CONFIG_API = "/api/seasonal/christmas-mode/config";
export const christmasModeConfigQueryKey = [CHRISTMAS_MODE_CONFIG_API] as const;

export type ChristmasModeConfiguration = {
  enabled: boolean;
  userIds: string[];
  visuals: ChristmasVisualSettings;
  users: Array<{ id: string; username: string }>;
};

/** Developer-only management. This hook is only mounted by Developer Settings. */
export function useChristmasModeConfiguration() {
  const configQuery = useQuery<ChristmasModeConfiguration>({
    queryKey: christmasModeConfigQueryKey,
    queryFn: async () => {
      const response = await apiRequest("GET", CHRISTMAS_MODE_CONFIG_API);
      return (await response.json()) as ChristmasModeConfiguration;
    },
    staleTime: 15_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  const saveConfig = useMutation<
    { enabled: boolean; userIds: string[]; visuals: ChristmasVisualSettings },
    Error,
    { enabled: boolean; userIds: string[]; visuals: ChristmasVisualSettings }
  >({
    mutationFn: async (nextConfig) => {
      const response = await apiRequest("PUT", CHRISTMAS_MODE_CONFIG_API, nextConfig);
      return (await response.json()) as { enabled: boolean; userIds: string[]; visuals: ChristmasVisualSettings };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<ChristmasModeConfiguration>(christmasModeConfigQueryKey, (old) =>
        old ? { ...old, enabled: saved.enabled, userIds: saved.userIds, visuals: saved.visuals } : old
      );
      // In particular, if the Developer selected their own account, the
      // snowfall and login layer react immediately without a page refresh.
      void queryClient.invalidateQueries({ queryKey: christmasModeQueryKey });
      void queryClient.invalidateQueries({ queryKey: christmasModeConfigQueryKey });
    },
  });

  return { configQuery, saveConfig };
}
