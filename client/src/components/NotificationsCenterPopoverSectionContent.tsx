// Extracted from ./NotificationsCenterPopoverSection.tsx
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, CheckCircle, Loader2, XCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { EVENT_META, formatAmount, getNavPath, useNotificationsCenterState } from "./useNotificationsCenterState";

export function NotificationsCenterPopoverSectionContent({
  activeTab,
  handleNotifClick,
  icLoading,
  icRequests,
  markReadMutation,
  notifList,
  notifLoading,
  selectedCompany,
  setApproveReq,
  setDismissNote,
  setDismissReq,
  setSelectedAccountId,
  showNotifEmpty,
}: Pick<
  Pick<
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
  >,
  | "activeTab"
  | "handleNotifClick"
  | "icLoading"
  | "icRequests"
  | "markReadMutation"
  | "notifList"
  | "notifLoading"
  | "selectedCompany"
  | "setApproveReq"
  | "setDismissNote"
  | "setDismissReq"
  | "setSelectedAccountId"
  | "showNotifEmpty"
>) {
  return (
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
                  <span className="font-semibold">{formatAmount(req.amount)}</span>
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
                  className={cn("px-4 py-3 space-y-1.5", !item.isRead && "bg-primary/5 border-l-2 border-l-primary")}
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
  );
}
