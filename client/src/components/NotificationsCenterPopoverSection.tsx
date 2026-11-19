// Extracted from ./NotificationsCenter.tsx to keep that module under the source-size cap.
import { PillTabButton, TabsList } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Bell, CheckCheck, ExternalLink, Loader2 } from "lucide-react";
import { TABS, useNotificationsCenterState } from "./useNotificationsCenterState";
import { NotificationsCenterPopoverSectionContent } from "./NotificationsCenterPopoverSectionContent";

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
        <NotificationsCenterPopoverSectionContent
          activeTab={activeTab}
          handleNotifClick={handleNotifClick}
          icLoading={icLoading}
          icRequests={icRequests}
          markReadMutation={markReadMutation}
          notifList={notifList}
          notifLoading={notifLoading}
          selectedCompany={selectedCompany}
          setApproveReq={setApproveReq}
          setDismissNote={setDismissNote}
          setDismissReq={setDismissReq}
          setSelectedAccountId={setSelectedAccountId}
          showNotifEmpty={showNotifEmpty}
        />
      </PopoverContent>
    </Popover>
  );
}
