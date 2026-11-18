import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";

export interface UserPrefs {
  dateFormat?: string;
  preferredCurrency?: string | null;
  showProfitComparisonOnPOS?: boolean;
  showChatWidget?: boolean;
  showNotesPanel?: boolean;
  factoryNetPositionValuationMode?: "cost" | "selling";
  factoryMhdViewDefault?: boolean;
}

export function useUserPreferences() {
  const [location] = useLocation();
  const isLogin = location === "/login";

  const { data, isLoading } = useQuery<UserPrefs>({
    queryKey: ["/api/user-preferences"],
    enabled: !isLogin,
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<UserPrefs>) => apiRequest("PUT", "/api/user-preferences", patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/user-preferences"] }),
  });

  return {
    prefs: data,
    isLoading,
    updatePref: (patch: Partial<UserPrefs>) => mutation.mutate(patch),
    /** Same write as updatePref, awaited, for sections that save on an explicit Save button. */
    savePrefs: (patch: Partial<UserPrefs>) => mutation.mutateAsync(patch),
    isPending: mutation.isPending,
  };
}
