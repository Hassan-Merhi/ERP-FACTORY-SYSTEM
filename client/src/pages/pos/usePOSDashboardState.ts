// Extracted from ./POSDashboard.tsx to keep that module under the source-size cap.
import type { AuthMe } from "@shared/apiTypes";
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

/** Safely format a date-time value as "hh:mm a". Returns "—" for null/invalid values. */
export function safeFmtTime(dt: string | null | undefined): string {
  if (!dt) return "—";
  const d = new Date(dt);
  if (isNaN(d.getTime())) return "—";
  return format(d, "hh:mm a");
}

interface PosShift {
  id: number;
  companyId: number;
  locationId: number;
  userId: string;
  username: string;
  cashAccountId: number | null;
  posStation: number | null;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  closingCash: string | null;
  expectedCash: string | null;
  variance: string | null;
  salesCount: number | null;
  salesTotal: string | null;
  notes: string | null;
}

interface PosTodayVoucher {
  voucherType?: string | null;
  totalAmount?: string | number | null;
}

interface Location {
  id: number;
  code: string;
  name: string;
}

export interface POSDashboardProps {
  posUser?: AuthMe;
}

export function usePOSDashboardState({ posUser }: POSDashboardProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();
  const { formatDisplayDate } = useDateFormat();
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [openShiftDialog, setOpenShiftDialog] = useState(false);
  const [closeShiftDialog, setCloseShiftDialog] = useState(false);
  const [openingCash, setOpeningCash] = useState("");
  const [closingCash, setClosingCash] = useState("");
  const [closeNotes, setCloseNotes] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  // Monitor online/offline status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Get POS user's assigned location
  const {
    data: location,
    isError: locationError,
    refetch: refetchLocation,
  } = useQuery<Location>({
    queryKey: posUser?.assignedLocationId ? [`/api/locations/${posUser.assignedLocationId}`] : [],
    enabled: !!posUser?.assignedLocationId,
  });

  const locationId = posUser?.assignedLocationId;

  // Fetch current shift
  const {
    data: currentShift,
    isLoading: shiftLoading,
    isError: shiftError,
    refetch: refetchShift,
  } = useQuery<PosShift | null>({
    queryKey: locationId ? ["/api/pos/shifts/current", { locationId }] : [],
    queryFn: async () => {
      if (!locationId) return null;
      const res = await fetch(`/api/pos/shifts/current?locationId=${locationId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!locationId,
  });

  // Fetch today's sales data
  const {
    data: todayVouchers = [],
    isLoading: salesLoading,
    isError: salesError,
    refetch: refetchSales,
  } = useQuery<PosTodayVoucher[]>({
    queryKey: locationId ? [`/api/locations/${locationId}/vouchers/today`] : [],
    enabled: !!locationId,
  });

  // Calculate today's sales from vouchers
  const todaySales = (() => {
    const salesVouchers = todayVouchers?.filter((v) => v.voucherType === "Sales") || [];
    const totalRaw = salesVouchers.reduce((sum: number, v) => sum + Number(v.totalAmount ?? 0), 0);
    return {
      count: salesVouchers.length,
      total: totalRaw,
      average: salesVouchers.length > 0 ? totalRaw / salesVouchers.length : 0,
    };
  })();

  // Fetch shift history
  const { data: shiftHistory = [] } = useQuery<PosShift[]>({
    queryKey: locationId ? ["/api/pos/shifts/history", { locationId }] : [],
    enabled: !!locationId && showHistory,
  });

  // Open shift mutation
  const openShiftMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/pos/shifts/open", {
        locationId,
        cashAccountId: posUser?.cashAccountId,
        openingCash,
        posStation: posUser?.posStation,
      });
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pos/shifts/current", { locationId }] });
      setOpenShiftDialog(false);
      setOpeningCash("");
      toast({
        title: "Shift Started",
        description: "Your shift has been opened successfully.",
      });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to open shift",
        variant: "destructive",
      });
    },
  });

  // Close shift mutation
  const closeShiftMutation = useMutation({
    mutationFn: async () => {
      if (!currentShift) throw new Error("No active shift");
      const res = await apiRequest("POST", `/api/pos/shifts/${currentShift.id}/close`, {
        closingCash,
        notes: closeNotes,
      });
      return await res.json();
    },
    onSuccess: (data: PosShift) => {
      queryClient.invalidateQueries({ queryKey: ["/api/pos/shifts/current", { locationId }] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/shifts/history", { locationId }] });
      setCloseShiftDialog(false);
      setClosingCash("");
      setCloseNotes("");

      const variance = parseFloat(data.variance || "0");
      toast({
        title: "Shift Closed",
        description: `Your shift has been closed. ${variance !== 0 ? `Variance: ${formatAmount(variance)}` : "Cash balanced!"}`,
        variant: variance !== 0 ? "destructive" : "default",
      });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to close shift",
        variant: "destructive",
      });
    },
  });
  return {
    closeNotes,
    closeShiftDialog,
    closeShiftMutation,
    closingCash,
    currentShift,
    formatAmount,
    formatDisplayDate,
    isOnline,
    location,
    locationError,
    locationId,
    navigate,
    openShiftDialog,
    openShiftMutation,
    openingCash,
    posUser,
    refetchLocation,
    refetchSales,
    refetchShift,
    salesError,
    salesLoading,
    setCloseNotes,
    setCloseShiftDialog,
    setClosingCash,
    setOpenShiftDialog,
    setOpeningCash,
    setShowHistory,
    shiftError,
    shiftHistory,
    shiftLoading,
    showHistory,
    toast,
    todaySales,
  };
}
