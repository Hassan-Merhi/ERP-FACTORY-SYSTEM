import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

const CHRISTMAS_MODE_API = "/api/seasonal/christmas-mode";
export const christmasModeQueryKey = [CHRISTMAS_MODE_API] as const;

export type ChristmasModeSetting = { enabled: boolean };

/**
 * One global Christmas Mode flag for every company and user.
 * This hook is shared by Settings (Phase 1) and the global effects in later phases.
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
    refetchInterval: () =>
      typeof document === "undefined" || document.visibilityState === "visible" ? 30_000 : false,
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

  return { settingQuery, updateSetting };
}
