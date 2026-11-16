import { Banknote, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductionBonusCategoryRatesPanel } from "./ProductionBonusCategoryRatesPanel";
import { ProductionBonusWeeklyMethodPanel } from "./ProductionBonusWeeklyMethodPanel";
import { ProductionBonusWeeklySheet } from "./ProductionBonusWeeklySheet";
import { ProductionBonusManualPaymentPanel } from "./ProductionBonusManualPaymentPanel";
import { ProductionBonusWeeklyPreviewPanel } from "./ProductionBonusWeeklyPreviewPanel";
import { ProductionTargetWeeklyBonusPaymentsPanel } from "./ProductionTargetWeeklyBonusPaymentsPanel";
import { useProductionBonusCheckoutPanelState } from "./useProductionBonusCheckoutPanelState";
import {
  ProductionBonusCheckoutPanelSection,
  ProductionBonusCheckoutPanelSection2,
  ProductionBonusCheckoutPanelSection3,
  ProductionBonusCheckoutPanelSection4,
} from "./ProductionBonusCheckoutPanelSection";
import { ProductionBonusCheckoutPanelDialogSection } from "./ProductionBonusCheckoutPanelDialogSection";

/** A single checkout: select workers, verify locked amounts, then approve and post. */
export function ProductionBonusCheckoutPanel(props: { initialDate: string }) {
  const {
    accountId,
    activeSelection,
    allSelected,
    canUse,
    cashAccounts,
    chosen,
    confirmPay,
    editingRate,
    error,
    from,
    groups,
    includesWeeklyBonuses,
    isLoading,
    manualAmounts,
    manualMode,
    manualSelected,
    manuallyPaidIds,
    method,
    newRate,
    offers,
    pay,
    payableGroups,
    paymentDate,
    payments,
    projectedWeeklyWorkers,
    recordChanges,
    reverse,
    reverseMutation,
    reverseReason,
    saveRate,
    search,
    selectableGroups,
    selectedGroups,
    setAccountId,
    setConfirmPay,
    setEditingRate,
    setFrom,
    setManualAmounts,
    setManualMode,
    setManualSelected,
    setMethod,
    setNewRate,
    setPaymentDate,
    setReverse,
    setReverseReason,
    setSearch,
    setSelected,
    setShowAll,
    setTo,
    showAll,
    t,
    to,
    tooMany,
    total,
    validRange,
    visibleGroups,
  } = useProductionBonusCheckoutPanelState(props);

  if (!canUse) return null;
  return (
    <Card data-testid="production-bonus-checkout" className="overflow-hidden border-border/70 shadow-xs">
      <CardContent className="space-y-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Banknote className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{t("payWorkers")}</h2>
            <p className="text-sm text-muted-foreground">{t("payIntro")}</p>
          </div>
        </div>

        <ProductionBonusCheckoutPanelSection3
          from={from}
          method={method}
          setFrom={setFrom}
          setManualAmounts={setManualAmounts}
          setManualSelected={setManualSelected}
          setMethod={setMethod}
          setSelected={setSelected}
          setTo={setTo}
          t={t}
          to={to}
        />

        {!validRange && (
          <p role="alert" className="text-sm text-destructive">
            {t("invalidRange")}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {(error as Error).message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {manualMode ? (
            <span className="text-sm font-medium">
              {groups.length - manuallyPaidIds.length} available for manual payment
            </span>
          ) : (
            <span className="text-sm font-medium">
              {payableGroups.length} {t("ready")}
            </span>
          )}
          <span className="text-sm text-muted-foreground">
            {groups.length} {t("totalWorkers")}
          </span>
          {includesWeeklyBonuses && (
            <span className="rounded-full border border-indigo-500/25 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
              {projectedWeeklyWorkers} weekly bonuses projected ·{" "}
              {manualMode
                ? "enter a separate manual payout or use the calculated weekly approval below"
                : "select after weekly approval below"}
            </span>
          )}
        </div>

        <ProductionBonusCheckoutPanelSection4
          manualMode={manualMode}
          setManualMode={setManualMode}
          setShowAll={setShowAll}
        />
        <ProductionBonusCheckoutPanelSection2
          allSelected={allSelected}
          manualMode={manualMode}
          search={search}
          selectableGroups={selectableGroups}
          setManualSelected={setManualSelected}
          setSearch={setSearch}
          setSelected={setSelected}
          setShowAll={setShowAll}
          showAll={showAll}
          t={t}
        />

        {!manualMode && !isLoading && groups.length > 0 && payableGroups.length === 0 && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3 text-sm text-foreground"
          >
            <strong>No payable daily bonuses in this date range.</strong>{" "}
            {includesWeeklyBonuses
              ? "The amounts marked Bonus projected are weekly-flat estimates, not payable daily bonuses. Complete and approve the week, then use Weekly Bonus Review & Pay below to select workers."
              : "Only bonuses with positive, approved or pending extra-bale amounts can be selected. Check rates, targets, and approval status."}
          </div>
        )}
        <ProductionBonusWeeklySheet
          from={from}
          to={to}
          workers={visibleGroups}
          loading={isLoading}
          selected={activeSelection}
          manualMode={manualMode}
          manualAmounts={manualAmounts}
          manuallyPaidIds={manuallyPaidIds}
          onAmountChange={(workerId, amount) => setManualAmounts((previous) => ({ ...previous, [workerId]: amount }))}
          onToggle={(workerId, checked) => {
            const update = (previous: number[]) =>
              checked ? [...new Set([...previous, workerId])] : previous.filter((id) => id !== workerId);
            if (manualMode) setManualSelected(update);
            else setSelected(update);
          }}
          renderDayActions={(workerId, date) => {
            if (manualMode || !recordChanges.allowed) return null;
            const day = offers.find((row) => row.workerId === workerId && row.date === date);
            if (!day) return null;
            const payment = (payments?.payments ?? []).find((row) => row.workerId === workerId && row.date === date);
            const canEditRate =
              method === "standard" &&
              day.extra > 0 &&
              (day.status === "pending" ||
                day.status === "approved" ||
                (day.status === "needs_setup" && day.issue?.includes("rate")));
            if (!canEditRate && payment?.paymentStatus !== "POSTED") return null;
            return (
              <div className="mt-1 flex flex-wrap justify-center gap-1">
                {canEditRate && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setEditingRate(day);
                      setNewRate(day.lines[0]?.rate ?? "");
                    }}
                  >
                    <Pencil className="mr-1 h-3 w-3" />
                    {t("editRate")}
                  </Button>
                )}
                {payment?.paymentStatus === "POSTED" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setReverse(payment);
                      setReverseReason("");
                    }}
                  >
                    <RotateCcw className="mr-1 h-3 w-3" />
                    {t("reverse")}
                  </Button>
                )}
              </div>
            );
          }}
        />

        {manualMode && (
          <ProductionBonusManualPaymentPanel
            rosterDate={to}
            workers={groups}
            selected={manualSelected}
            amounts={manualAmounts}
            onReset={() => {
              setManualSelected([]);
              setManualAmounts({});
            }}
          />
        )}
        {includesWeeklyBonuses && (
          <details
            className="hidden overflow-hidden rounded-xl border border-indigo-500/25 bg-card"
            data-testid="production-bonus-weekly-pay-section"
          >
            <summary className="cursor-pointer bg-indigo-500/[0.07] px-4 py-3 text-sm font-semibold text-foreground">
              Weekly Bonus Review & Pay — approve, select workers, and post approved amounts
            </summary>
            <div className="space-y-4 border-t border-indigo-500/20 p-3 sm:p-4">
              <p className="text-sm text-muted-foreground">
                Weekly bonuses shown in the sheet cannot be paid through daily checkout. First approve a completed week
                below, then tick individual approved workers in Weekly Flat Bonus Payments. The calculated amount is
                locked for accounting; change the configured weekly bonus rate before approval if needed.
              </p>
              <ProductionBonusWeeklyMethodPanel initialDate={to} />
              <ProductionBonusWeeklyPreviewPanel initialDate={to} />
              <ProductionTargetWeeklyBonusPaymentsPanel initialDate={to} />
            </div>
          </details>
        )}
        {!manualMode && (
          <ProductionBonusCheckoutPanelSection
            accountId={accountId}
            cashAccounts={cashAccounts}
            chosen={chosen}
            pay={pay}
            paymentDate={paymentDate}
            recordChanges={recordChanges}
            selectedGroups={selectedGroups}
            setAccountId={setAccountId}
            setConfirmPay={setConfirmPay}
            setPaymentDate={setPaymentDate}
            t={t}
            tooMany={tooMany}
            total={total}
            validRange={validRange}
          />
        )}
        {!manualMode && tooMany && (
          <p role="alert" className="text-sm text-destructive">
            {t("max100")}
          </p>
        )}

        <details className="hidden rounded-lg border border-border/70">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t("settings")}</summary>
          <div className="space-y-3 border-t p-3">
            <p className="text-xs text-muted-foreground">{t("settingsHint")}</p>
            <ProductionBonusCategoryRatesPanel initialDate={from} />
            {!includesWeeklyBonuses && (
              <details className="rounded-lg border">
                <summary className="cursor-pointer px-3 py-2 text-xs">{t("legacy")}</summary>
                <ProductionBonusWeeklyMethodPanel initialDate={to} />
              </details>
            )}
          </div>
        </details>
      </CardContent>

      <ProductionBonusCheckoutPanelDialogSection
        accountId={accountId}
        cashAccounts={cashAccounts}
        chosen={chosen}
        confirmPay={confirmPay}
        pay={pay}
        paymentDate={paymentDate}
        setAccountId={setAccountId}
        setConfirmPay={setConfirmPay}
        setPaymentDate={setPaymentDate}
        t={t}
        tooMany={tooMany}
        total={total}
      />
      <Dialog
        open={Boolean(editingRate)}
        onOpenChange={(open) => {
          if (!open) setEditingRate(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("rateTitle")}</DialogTitle>
            <DialogDescription>
              {t("rateHint")} {editingRate?.workerName}.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-sm">
            {t("perExtra")}
            <Input
              type="number"
              min="0.0001"
              max="10000"
              step="0.0001"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingRate(null)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={saveRate.isPending || !/^\d+(?:\.\d{1,4})?$/.test(newRate) || Number(newRate) <= 0}
              onClick={() => saveRate.mutate()}
            >
              {t("saveRate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(reverse)}
        onOpenChange={(open) => {
          if (!open) setReverse(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("reverseTitle")}</DialogTitle>
            <DialogDescription>{t("reverseHint")}</DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-sm">
            {t("reason")}
            <Input
              value={reverseReason}
              onChange={(event) => setReverseReason(event.target.value)}
              placeholder={t("reasonHint")}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverse(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!reverseReason.trim() || reverseMutation.isPending}
              onClick={() => reverseMutation.mutate()}
            >
              {t("confirmReverse")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
