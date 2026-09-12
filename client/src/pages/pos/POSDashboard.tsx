import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ShoppingCart,
  Clock,
  DollarSign,
  TrendingUp,
  Play,
  Square,
  FileText,
  Wallet,
  History,
  AlertCircle,
  WifiOff,
  Wifi,
} from "lucide-react";
import { format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";

import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ui/page-state";

/** Safely format a date-time value as "hh:mm a". Returns "—" for null/invalid values. */
function safeFmtTime(dt: string | null | undefined): string {
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

interface _TodaySales {
  count: number;
  total: string;
  average: string;
}

interface Location {
  id: number;
  code: string;
  name: string;
}

interface POSDashboardProps {
  posUser?: {
    id: string;
    username: string;
    assignedLocationId: number;
    cashAccountId: number | null;
    posStation: number | null;
  };
}

export default function POSDashboard({ posUser }: POSDashboardProps) {
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
  } = useQuery<{ voucherType?: string; totalAmount?: string | number | null }[]>({
    queryKey: locationId ? [`/api/locations/${locationId}/vouchers/today`] : [],
    enabled: !!locationId,
  });

  // Calculate today's sales from vouchers
  const todaySales = (() => {
    const salesVouchers = todayVouchers?.filter((v) => v.voucherType === "Sales") || [];
    const totalRaw = salesVouchers.reduce((sum: number, v) => sum + parseFloat(String(v.totalAmount ?? "0")), 0);
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

  if (!posUser || !locationId) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center">
            <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-medium mb-2">No Location Assigned</h2>
            <p className="text-muted-foreground">Please contact your administrator to assign you to a location.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="POS Dashboard" subtitle={`${location?.name || "Loading..."} — ${posUser.username}`} />
        {isOnline ? (
          <Badge variant="outline" className="gap-1">
            <Wifi className="h-3 w-3" />
            Online
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1">
            <WifiOff className="h-3 w-3" />
            Offline
          </Badge>
        )}
      </div>

      {(locationError || shiftError || salesError) && (
        <ErrorState
          title="POS dashboard data unavailable"
          description="Some dashboard information could not be loaded. Retry without losing your shift context."
          actionLabel="Retry dashboard"
          onAction={() => {
            void refetchLocation();
            void refetchShift();
            void refetchSales();
          }}
        />
      )}

      {/* Stats pill bar */}
      <div className="flex flex-wrap gap-3">
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3 min-w-[130px]">
          <ShoppingCart className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Today's Sales</p>
            {salesLoading ? (
              <Skeleton className="h-5 w-12 mt-0.5" />
            ) : salesError ? (
              <span className="text-sm text-destructive">Unavailable</span>
            ) : (
              <p className="text-lg font-semibold leading-none" data-testid="text-today-sales-count">
                {todaySales?.count || 0}
              </p>
            )}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3 min-w-[160px]">
          <DollarSign className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Today's Revenue</p>
            {salesLoading ? (
              <Skeleton className="h-5 w-20 mt-0.5" />
            ) : salesError ? (
              <span className="text-sm text-destructive">Unavailable</span>
            ) : (
              <p className="text-lg font-semibold leading-none font-mono" data-testid="text-today-revenue">
                {formatAmount(todaySales?.total || 0)}
              </p>
            )}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3 min-w-[160px]">
          <TrendingUp className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Avg per Transaction</p>
            {salesLoading ? (
              <Skeleton className="h-5 w-16 mt-0.5" />
            ) : salesError ? (
              <span className="text-sm text-destructive">Unavailable</span>
            ) : (
              <p className="text-lg font-semibold leading-none font-mono" data-testid="text-average-sale">
                {formatAmount(todaySales?.average || 0)}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Shift Status */}
      <div
        className={`rounded-xl border px-5 py-4 ${currentShift ? "border-green-500/40 bg-green-50/20 dark:bg-green-950/10" : "bg-muted/30"}`}
      >
        <div className="flex items-center gap-2 mb-3">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Shift Status</span>
        </div>
        {shiftLoading ? (
          <Skeleton className="h-14 w-full" />
        ) : currentShift ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <Badge variant="default">Active Shift</Badge>
              <p className="text-sm text-muted-foreground">
                Started {formatDisplayDate(currentShift.openedAt)} at {safeFmtTime(currentShift.openedAt)}
              </p>
              <p className="text-sm">
                Opening Cash:{" "}
                <span className="font-semibold font-mono">{formatAmount(parseFloat(currentShift.openingCash))}</span>
              </p>
            </div>
            <Button
              variant="destructive"
              onClick={() => setCloseShiftDialog(true)}
              className="gap-2"
              data-testid="button-close-shift"
            >
              <Square className="h-4 w-4" />
              End Shift
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <Badge variant="secondary">No Active Shift</Badge>
              <p className="text-sm text-muted-foreground">Start a shift to begin making sales</p>
            </div>
            <Button onClick={() => setOpenShiftDialog(true)} className="gap-2" data-testid="button-start-shift">
              <Play className="h-4 w-4" />
              Start Shift
            </Button>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Quick Actions</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Button
            variant="outline"
            className="h-20 flex-col gap-2"
            onClick={() => navigate("/pos")}
            disabled={!currentShift}
            data-testid="button-new-sale"
          >
            <ShoppingCart className="h-5 w-5" />
            <span className="text-sm">New Sale</span>
          </Button>
          <Button
            variant="outline"
            className="h-20 flex-col gap-2"
            onClick={() => navigate("/pos-daybook")}
            data-testid="button-view-daybook"
          >
            <FileText className="h-5 w-5" />
            <span className="text-sm">View Daybook</span>
          </Button>
          <Button
            variant="outline"
            className="h-20 flex-col gap-2"
            onClick={() => setShowHistory(!showHistory)}
            data-testid="button-shift-history"
          >
            <History className="h-5 w-5" />
            <span className="text-sm">Shift History</span>
          </Button>
          <Button variant="outline" className="h-20 flex-col gap-2" disabled data-testid="button-cash-drawer">
            <Wallet className="h-5 w-5" />
            <span className="text-sm">Cash Drawer</span>
          </Button>
        </div>
      </div>

      {/* Shift History */}
      {showHistory && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Recent Shifts</p>
          <div className="border rounded-xl overflow-hidden">
            <div className="table-responsive">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs hidden sm:table-cell">Duration</TableHead>
                    <TableHead className="text-xs text-right">Opening</TableHead>
                    <TableHead className="text-xs text-right">Closing</TableHead>
                    <TableHead className="text-xs text-right">Sales</TableHead>
                    <TableHead className="text-xs hidden sm:table-cell text-right">Variance</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shiftHistory.slice(0, 10).map((shift) => {
                    const variance = parseFloat(shift.variance || "0");
                    return (
                      <TableRow key={shift.id} data-testid={`row-shift-${shift.id}`}>
                        <TableCell className="text-sm">{formatDisplayDate(shift.openedAt)}</TableCell>
                        <TableCell className="text-sm hidden sm:table-cell text-muted-foreground">
                          {shift.closedAt ? (
                            <>
                              {safeFmtTime(shift.openedAt)} – {safeFmtTime(shift.closedAt)}
                            </>
                          ) : (
                            safeFmtTime(shift.openedAt) + " – Active"
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatAmount(parseFloat(shift.openingCash))}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {shift.closingCash ? formatAmount(parseFloat(shift.closingCash)) : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {shift.salesTotal ? formatAmount(parseFloat(shift.salesTotal)) : "—"}
                          {shift.salesCount ? (
                            <span className="text-muted-foreground text-xs ml-1">({shift.salesCount})</span>
                          ) : (
                            ""
                          )}
                        </TableCell>
                        <TableCell
                          className={`hidden sm:table-cell text-right font-mono text-sm ${variance !== 0 ? "text-destructive" : "text-green-600 dark:text-green-400"}`}
                        >
                          {shift.variance ? formatAmount(variance) : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={shift.status === "open" ? "default" : "secondary"} className="capitalize">
                            {shift.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {shiftHistory.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                        No shift history found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}

      {/* Open Shift Dialog */}
      <Dialog open={openShiftDialog} onOpenChange={setOpenShiftDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start New Shift</DialogTitle>
            <DialogDescription>Enter the opening cash amount in your drawer to begin your shift.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="openingCash">Opening Cash Amount</Label>
              <Input
                id="openingCash"
                type="number"
                step="0.01"
                placeholder="0"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                data-testid="input-opening-cash"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenShiftDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!navigator.onLine) {
                  toast({
                    title: "Not available offline",
                    description: "Shift operations require a connection",
                    variant: "destructive",
                  });
                  return;
                }
                openShiftMutation.mutate();
              }}
              disabled={openShiftMutation.isPending}
              data-testid="button-confirm-start-shift"
            >
              {openShiftMutation.isPending ? "Starting..." : "Start Shift"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close Shift Dialog */}
      <Dialog open={closeShiftDialog} onOpenChange={setCloseShiftDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End Shift</DialogTitle>
            <DialogDescription>Count your cash drawer and enter the closing amount.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {currentShift && (
              <div className="bg-muted p-4 rounded-lg space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Opening Cash:</span>
                  <span className="font-mono">{formatAmount(parseFloat(currentShift.openingCash))}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Shift Started:</span>
                  <span>{safeFmtTime(currentShift.openedAt)}</span>
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="closingCash">Closing Cash Amount</Label>
              <Input
                id="closingCash"
                type="number"
                step="0.01"
                placeholder="0"
                value={closingCash}
                onChange={(e) => setClosingCash(e.target.value)}
                data-testid="input-closing-cash"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="closeNotes">Notes (optional)</Label>
              <Textarea
                id="closeNotes"
                placeholder="Any notes about this shift..."
                value={closeNotes}
                onChange={(e) => setCloseNotes(e.target.value)}
                data-testid="input-close-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseShiftDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!navigator.onLine) {
                  toast({
                    title: "Not available offline",
                    description: "Shift operations require a connection",
                    variant: "destructive",
                  });
                  return;
                }
                closeShiftMutation.mutate();
              }}
              disabled={closeShiftMutation.isPending || !closingCash}
              data-testid="button-confirm-end-shift"
            >
              {closeShiftMutation.isPending ? "Closing..." : "End Shift"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
