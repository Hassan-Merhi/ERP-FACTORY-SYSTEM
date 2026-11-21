// Extracted from ./LocationDialogsView.tsx
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LocationDialogsProps } from "./LocationDialogsTypes";

export function useLocationDialogsState({
  waGroupDialogOpen,
  waChats,
  waGroupSearch,
  waGroupSelectedId,
  waGroupLocation,
}: Pick<
  LocationDialogsProps,
  "waGroupDialogOpen" | "waChats" | "waGroupSearch" | "waGroupSelectedId" | "waGroupLocation"
>) {
  const [waEnabled, setWaEnabled] = useState(false);

  // Subscribe to the exact same React Query cache entry used by the page-level
  // group loader. This adds no duplicate request, but it lets the dialog surface
  // the actual disconnected/credentials/API failure and provide an explicit retry.
  const {
    error: waChatsError,
    refetch: refetchWaChats,
    isFetching: waChatsRefreshing,
  } = useQuery<{ id: string; name: string; type: string }[]>({
    queryKey: ["/api/location-inventory/whatsapp/groups"],
    queryFn: async () => {
      const res = await fetch("/api/location-inventory/whatsapp/groups", { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Failed to fetch WhatsApp groups: ${res.status}`);
      }
      return res.json();
    },
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!waGroupDialogOpen) return;
    setWaEnabled(Boolean(waGroupLocation?.whatsappStockReportsEnabled ?? waGroupLocation?.whatsappGroupChatId));
  }, [waGroupDialogOpen, waGroupLocation]);

  const filteredWaChats = useMemo(() => {
    const search = waGroupSearch.trim().toLowerCase();
    if (!search) return waChats;
    return waChats.filter((chat) =>
      String(chat.name ?? "")
        .toLowerCase()
        .includes(search)
    );
  }, [waChats, waGroupSearch]);

  const selectedWaGroup = useMemo(
    () => waChats.find((chat) => chat.id === waGroupSelectedId),
    [waChats, waGroupSelectedId]
  );
  const selectedWaGroupName =
    selectedWaGroup?.name ||
    (waGroupSelectedId === waGroupLocation?.whatsappGroupChatId ? waGroupLocation?.whatsappGroupName : null) ||
    null;
  const waConnectionError =
    waChatsError instanceof Error
      ? waChatsError.message
      : waChatsError
        ? "Could not load WhatsApp groups from the connected account."
        : null;
  return {
    setWaEnabled,
    waEnabled,
    waChatsRefreshing,
    refetchWaChats,
    filteredWaChats,
    selectedWaGroupName,
    waConnectionError,
  };
}
