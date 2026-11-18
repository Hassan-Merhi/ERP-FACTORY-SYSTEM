import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatAmount, useNotificationsCenterState } from "./useNotificationsCenterState";
import { NotificationsCenterPopoverSection } from "./NotificationsCenterPopoverSection";

// ── Main Component ─────────────────────────────────────────────────────────────

export function NotificationsCenter() {
  const {
    activeTab,
    approveMutation,
    approveReq,
    confirmBulkDismiss,
    destAccounts,
    dismissAllICMutation,
    dismissMutation,
    dismissNote,
    dismissReq,
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
    selectedAccountId,
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
  } = useNotificationsCenterState();

  return (
    <>
      <NotificationsCenterPopoverSection
        activeTab={activeTab}
        dismissAllICMutation={dismissAllICMutation}
        handleNotifClick={handleNotifClick}
        icCountData={icCountData}
        icLoading={icLoading}
        icRequests={icRequests}
        markAllReadMutation={markAllReadMutation}
        markReadMutation={markReadMutation}
        navigate={navigate}
        notifList={notifList}
        notifLoading={notifLoading}
        open={open}
        selectedCompany={selectedCompany}
        setActiveTab={setActiveTab}
        setApproveReq={setApproveReq}
        setConfirmBulkDismiss={setConfirmBulkDismiss}
        setDismissNote={setDismissNote}
        setDismissReq={setDismissReq}
        setOpen={setOpen}
        setSelectedAccountId={setSelectedAccountId}
        showNotifEmpty={showNotifEmpty}
        totalBadge={totalBadge}
        unreadData={unreadData}
        unreadInView={unreadInView}
      />

      {/* IC Approve Dialog */}
      <Dialog
        open={!!approveReq}
        onOpenChange={(o) => {
          if (!o) setApproveReq(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Payment Request</DialogTitle>
          </DialogHeader>
          {approveReq && (
            <div className="space-y-4 py-2">
              <div className="text-sm space-y-1">
                <p>
                  <span className="text-muted-foreground">From:</span> {approveReq.fromCompanyName}
                </p>
                <p>
                  <span className="text-muted-foreground">Amount:</span> {formatAmount(approveReq.amount)}
                </p>
                <p>
                  <span className="text-muted-foreground">CR side:</span> {approveReq.linkDestLedgerName}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="dest-account-select">Debit account (where money was received)</Label>
                <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                  <SelectTrigger id="dest-account-select" data-testid="select-dest-account">
                    <SelectValue placeholder="Select account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {destAccounts
                      .filter((a) => a.id !== approveReq.linkDestLedgerAccountId)
                      .map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                A Receipt voucher will be created in <strong>{approveReq.destCompanyName}</strong>: DR selected account
                · CR {approveReq.linkDestLedgerName}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveReq(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                approveReq &&
                approveMutation.mutate({ id: approveReq.id, destLedgerAccountId: parseInt(selectedAccountId) })
              }
              disabled={!selectedAccountId || approveMutation.isPending}
              data-testid="button-confirm-approve"
            >
              {approveMutation.isPending ? "Approving…" : "Approve & Post"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm that bulk dismissal is a request decision, not just hiding an alert. */}
      <Dialog
        open={confirmBulkDismiss}
        onOpenChange={(value) => {
          if (!dismissAllICMutation.isPending) setConfirmBulkDismiss(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss all intercompany requests?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Dismiss all {icRequests.length} pending intercompany payment
            {icRequests.length === 1 ? " request" : " requests"} shown to you? These requests will no longer be
            available for approval. No mirror vouchers will be posted, and existing vouchers will not be deleted.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={dismissAllICMutation.isPending}
              onClick={() => setConfirmBulkDismiss(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={icRequests.length === 0 || dismissAllICMutation.isPending}
              data-testid="button-confirm-ic-dismiss-all"
              onClick={() => dismissAllICMutation.mutate(icRequests.map((request) => request.id))}
            >
              {dismissAllICMutation.isPending ? "Dismissing…" : `Dismiss all (${icRequests.length})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* IC Dismiss Dialog */}
      <Dialog
        open={!!dismissReq}
        onOpenChange={(o) => {
          if (!o) setDismissReq(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              This will mark the request as dismissed without posting a mirror voucher.
            </p>
            <div className="space-y-2">
              <Label htmlFor="dismiss-note">Note (optional)</Label>
              <Textarea
                id="dismiss-note"
                placeholder="Reason for dismissal…"
                value={dismissNote}
                onChange={(e) => setDismissNote(e.target.value)}
                data-testid="input-dismiss-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissReq(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => dismissReq && dismissMutation.mutate({ id: dismissReq.id, note: dismissNote })}
              disabled={dismissMutation.isPending}
              data-testid="button-confirm-dismiss"
            >
              {dismissMutation.isPending ? "Dismissing…" : "Dismiss"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
