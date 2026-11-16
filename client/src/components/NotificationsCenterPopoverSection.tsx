// Extracted from ./NotificationsCenter.tsx to keep that module under the source-size cap.
import { PillTabButton, TabsList } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowRight, Bell, CheckCheck, CheckCircle, ExternalLink, Loader2, XCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { EVENT_META, TABS, formatAmount, getNavPath, useNotificationsCenterState } from "./useNotificationsCenterState";

export function NotificationsCenterPopoverSection({
  activeTab,
  dismissAllICMutation,
  handleNotifClick,
  icCountData,
  icLoading,
  icRequests,
  markAllReadMutation,
  markReadMutation,
  navigate,
  notifList,
  notifLoading,
  open,
  selectedCompany,
  setActiveTab,
  setApproveReq,
  setConfirmBulkDismiss,
  setDismissNote,
  setDismissReq,
  setOpen,
  setSelectedAccountId,
  showNotifEmpty,
  totalBadge,
  unreadData,
  unreadInView,
}: Pick<
  ReturnType<typeof useNotificationsCenterState>,
  | "activeTab"
  | "dismissAllICMutation"
  | "handleNotifClick"
  | "icCountData"
  | "icLoading"
  | "icRequests"
  | "markAllReadMutation"
  | "markReadMutation"
  | "navigate"
  | "notifList"
  | "notifLoading"
  | "open"
  | "selectedCompany"
  | "setActiveTab"
  | "setApproveReq"
  | "setConfirmBulkDismiss"
  | "setDismissNote"
  | "setDismissReq"
  | "setOpen"
  | "setSelectedAccountId"
  | "showNotifEmpty"
  | "totalBadge"
  | "unreadData"
  | "unreadInView"
>) {
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <Button variant="ghost" size="icon" title="Notifications" data-testid="button-notifications-bell">
            <Bell className="h-4 w-4" />
          </Button>
          {totalBadge > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-0.5 rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold flex items-center justify-center pointer-events-none"
              data-testid="badge-notif-count"
            >
              {totalBadge > 99 ? "99+" : totalBadge}
            </span>
          )}
        </div>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-96 p-0" data-testid="popover-notifications">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <p className="text-sm font-semibold">Notifications</p>
            <p className="text-xs text-muted-foreground">{totalBadge > 0 ? `${totalBadge} unread` : "All caught up"}</p>
          </div>
          <div className="flex items-center gap-1">
            {unreadInView > 0 && activeTab !== "intercompany" && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1 h-7"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                data-testid="button-mark-all-read"
                title="Mark all as read"
              >
                {markAllReadMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCheck className="h-3 w-3" />
                )}
                <span className="hidden sm:inline">Mark all read</span>
              </Button>
            )}
            {activeTab === "intercompany" && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 px-2"
                  disabled={icLoading || icRequests.length === 0 || dismissAllICMutation.isPending}
                  onClick={() => setConfirmBulkDismiss(true)}
                  data-testid="button-ic-dismiss-all"
                >
                  {dismissAllICMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Dismiss all"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1 h-7 px-2"
                  onClick={() => {
                    setOpen(false);
                    navigate("/intercompany-requests");
                  }}
                  data-testid="button-ic-view-all"
                >
                  View all
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Tab bar */}
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="w-max max-w-full" aria-label="Notifications">
            {TABS.map((tab) => (
              <PillTabButton
                key={tab.id}
                data-testid={`tab-notif-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                selected={activeTab === tab.id}
              >
                {tab.label}
                {tab.id === "intercompany" && (icCountData?.count ?? 0) > 0 && (
                  <span className="ml-1 inline-flex h-3.5 min-w-3.5 px-0.5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold">
                    {icCountData!.count}
                  </span>
                )}
                {tab.id === "all" && (unreadData?.count ?? 0) > 0 && (
                  <span className="ml-1 inline-flex h-3.5 min-w-3.5 px-0.5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold">
                    {unreadData!.count}
                  </span>
                )}
              </PillTabButton>
            ))}
          </TabsList>
        </div>

        {/* Body */}
        <div className="max-h-[400px] overflow-y-auto">
          {/* Intercompany tab */}
          {activeTab === "intercompany" &&
            (icLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : icRequests.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                <CheckCircle className="h-6 w-6 text-emerald-500" />
                <p className="text-sm">No pending requests</p>
              </div>
            ) : (
              <div className="divide-y">
                {icRequests.map((req) => (
                  <div key={req.id} className="px-4 py-3 space-y-2" data-testid={`ic-request-${req.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-sm font-medium min-w-0">
                        <span className="truncate">{req.fromCompanyName}</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="truncate">{req.destCompanyName}</span>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatDistanceToNow(new Date(req.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="font-semibold">${formatAmount(req.amount)}</span>
                      <span className="text-muted-foreground text-xs truncate">CR: {req.linkDestLedgerName}</span>
                    </div>
                    {req.description && <p className="text-xs text-muted-foreground truncate">{req.description}</p>}
                    <div className="flex gap-2 pt-0.5">
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          setApproveReq(req);
                          setSelectedAccountId("");
                        }}
                        data-testid={`button-approve-${req.id}`}
                      >
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => {
                          setDismissReq(req);
                          setDismissNote("");
                        }}
                        data-testid={`button-dismiss-${req.id}`}
                      >
                        <XCircle className="h-3 w-3 mr-1" />
                        Dismiss
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ))}

          {/* Notifications tabs */}
          {activeTab !== "intercompany" &&
            (notifLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : showNotifEmpty ? (
              <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                <CheckCircle className="h-6 w-6 text-emerald-500" />
                <p className="text-sm">All caught up — no notifications</p>
              </div>
            ) : (
              <div className="divide-y">
                {notifList.map((item) => {
                  const meta = EVENT_META[item.eventType];
                  const navPath = getNavPath(
                    item,
                    selectedCompany?.companyType === "factory" || selectedCompany?.companyType === "factory_v2"
                  );
                  return (
                    <div
                      key={item.id}
                      data-testid={`notif-item-${item.id}`}
                      className={cn(
                        "px-4 py-3 space-y-1.5",
                        !item.isRead && "bg-primary/5 border-l-2 border-l-primary"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          {!item.isRead && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0 mt-0.5" />}
                          <span className="text-sm font-medium leading-snug truncate">{item.title}</span>
                        </div>
                        {meta && (
                          <Badge
                            variant="outline"
                            className={cn("text-[11px] px-1 h-4 font-medium shrink-0", meta.className)}
                          >
                            {meta.label}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{item.message}</p>
                      {/* Company info */}
                      {item.companyName && (
                        <p className="text-[11px] text-muted-foreground font-medium">{item.companyName}</p>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground leading-tight">
                          {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                          {item.triggeredByUsername && ` · by ${item.triggeredByUsername}`}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          {!item.isRead && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                markReadMutation.mutate(item.id);
                              }}
                              className="text-[11px] text-muted-foreground underline hover:text-foreground"
                              data-testid={`button-mark-read-${item.id}`}
                            >
                              Mark read
                            </button>
                          )}
                          {navPath && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[11px] px-2 gap-0.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleNotifClick(item);
                              }}
                              data-testid={`button-go-to-record-${item.id}`}
                            >
                              Go to record
                              <ArrowRight className="h-2.5 w-2.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
