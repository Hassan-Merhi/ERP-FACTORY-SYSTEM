// Extracted from ./ProductionBonusCheckoutPanel.tsx to keep that module under the source-size cap.
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isDate, usd } from "./ProductionBonusCheckoutPanelSummarizeByWorker";
import { useProductionBonusCheckoutPanelState } from "./useProductionBonusCheckoutPanelState";

export function ProductionBonusCheckoutPanelDialogSection({
  accountId,
  cashAccounts,
  chosen,
  confirmPay,
  pay,
  paymentDate,
  setAccountId,
  setConfirmPay,
  setPaymentDate,
  t,
  tooMany,
  total,
}: Pick<
  ReturnType<typeof useProductionBonusCheckoutPanelState>,
  | "accountId"
  | "cashAccounts"
  | "chosen"
  | "confirmPay"
  | "pay"
  | "paymentDate"
  | "setAccountId"
  | "setConfirmPay"
  | "setPaymentDate"
  | "t"
  | "tooMany"
  | "total"
>) {
  return (
    <Dialog open={confirmPay} onOpenChange={setConfirmPay}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("confirmTitle")}</DialogTitle>
          <DialogDescription>{t("confirmHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            {t("payFrom")}
            <UnifiedAccountPicker
              options={cashAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
              value={accountId}
              onChange={setAccountId}
              placeholder={t("chooseAccount")}
            />
          </label>
          <label className="space-y-1.5 text-sm">
            {t("paymentDate")}
            <Input
              aria-label={t("paymentDate")}
              type="date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.target.value)}
            />
          </label>
        </div>
        <div className="max-h-[250px] overflow-y-auto rounded-lg border">
          {chosen.map((row) => (
            <div key={row.date + ":" + row.workerId} className="flex justify-between gap-2 border-b px-3 py-2 text-sm">
              <div>
                <div className="font-medium">{row.workerName}</div>
                <div className="text-xs text-muted-foreground">
                  {row.date} · {row.extra} {t("extraBales")}
                </div>
              </div>
              <strong className="tabular-nums">{usd(row.amount)}</strong>
            </div>
          ))}
        </div>
        <div className="flex justify-between text-base font-bold">
          <span>{t("total")}</span>
          <span>{usd(total)}</span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmPay(false)}>
            {t("cancel")}
          </Button>
          <Button
            disabled={pay.isPending || !chosen.length || !accountId || !isDate(paymentDate) || tooMany}
            onClick={() => pay.mutate()}
          >
            {pay.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("approvePay")} {usd(total)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
