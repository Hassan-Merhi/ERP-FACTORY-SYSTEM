import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ui/page-state";
import { safeFmtTime, usePOSDashboardState, type POSDashboardProps } from "./usePOSDashboardState";
import { POSDashboardDialogSection, POSDashboardSection } from "./POSDashboardDialogSection";

export default function POSDashboard(props: POSDashboardProps) {
  const {
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
  } = usePOSDashboardState(props);

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
        <POSDashboardSection
          formatAmount={formatAmount}
          formatDisplayDate={formatDisplayDate}
          shiftHistory={shiftHistory}
        />
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
      <POSDashboardDialogSection
        closeNotes={closeNotes}
        closeShiftDialog={closeShiftDialog}
        closeShiftMutation={closeShiftMutation}
        closingCash={closingCash}
        currentShift={currentShift}
        formatAmount={formatAmount}
        setCloseNotes={setCloseNotes}
        setCloseShiftDialog={setCloseShiftDialog}
        setClosingCash={setClosingCash}
        toast={toast}
      />
    </div>
  );
}
