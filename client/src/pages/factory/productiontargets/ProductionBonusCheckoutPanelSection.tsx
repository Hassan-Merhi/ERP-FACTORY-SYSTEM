// Extracted from ./ProductionBonusCheckoutPanel.tsx to keep that module under the source-size cap.
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import { usd, type Method } from "./ProductionBonusCheckoutPanelSummarizeByWorker";
import { useProductionBonusCheckoutPanelState } from "./useProductionBonusCheckoutPanelState";

export function ProductionBonusCheckoutPanelSection({
  accountId,
  cashAccounts,
  chosen,
  pay,
  paymentDate,
  recordChanges,
  selectedGroups,
  setAccountId,
  setConfirmPay,
  setPaymentDate,
  t,
  tooMany,
  total,
  validRange,
}: Pick<
  ReturnType<typeof useProductionBonusCheckoutPanelState>,
  | "accountId"
  | "cashAccounts"
  | "chosen"
  | "pay"
  | "paymentDate"
  | "recordChanges"
  | "selectedGroups"
  | "setAccountId"
  | "setConfirmPay"
  | "setPaymentDate"
  | "t"
  | "tooMany"
  | "total"
  | "validRange"
>) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <div className="text-sm font-medium">
          {selectedGroups.length} {t("selected")}
        </div>
        <div className="text-2xl font-bold tabular-nums">{usd(total)}</div>
        <div className="text-xs text-muted-foreground">
          Daily total is calculated, not freely editable. Use Edit Rate on an eligible day to update an unpaid per-bale
          bonus.
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t("payFrom")}
          <UnifiedAccountPicker
                options={cashAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
                value={accountId}
                onChange={setAccountId}
                placeholder={t("chooseAccount")}
                ariaLabel={t("payFrom")}
                className="h-10 w-[230px]"
              />
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t("paymentDate")}
          <Input
            type="date"
            aria-label={t("paymentDate")}
            className="h-10 w-[165px]"
            value={paymentDate}
            onChange={(event) => setPaymentDate(event.target.value)}
          />
        </label>
        {recordChanges.allowed && (
          <Button
            className="h-10 sm:min-w-[170px]"
            disabled={!chosen.length || !validRange || tooMany || pay.isPending}
            onClick={() => setConfirmPay(true)}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            {t("reviewPay")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ProductionBonusCheckoutPanelSection2({
  allSelected,
  manualMode,
  search,
  selectableGroups,
  setManualSelected,
  setSearch,
  setSelected,
  setShowAll,
  showAll,
  t,
}: Pick<
  ReturnType<typeof useProductionBonusCheckoutPanelState>,
  | "allSelected"
  | "manualMode"
  | "search"
  | "selectableGroups"
  | "setManualSelected"
  | "setSearch"
  | "setSelected"
  | "setShowAll"
  | "showAll"
  | "t"
>) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 lg:flex-row lg:items-center lg:justify-between">
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label={t("searchWorkers")}
        placeholder={t("searchWorkers")}
        className="h-10 w-full lg:max-w-xs"
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
          {!manualMode && (
            <Button
              type="button"
              size="sm"
              variant={!showAll ? "secondary" : "ghost"}
              className="h-8"
              onClick={() => setShowAll(false)}
            >
              {t("showPayable")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={showAll ? "secondary" : "ghost"}
            className="h-8"
            onClick={() => setShowAll(true)}
          >
            {t("showEveryone")}
          </Button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!selectableGroups.length}
          onClick={() => {
            const ids = selectableGroups.map((group) => group.workerId);
            if (manualMode)
              setManualSelected((previous) =>
                allSelected ? previous.filter((id) => !ids.includes(id)) : [...new Set([...previous, ...ids])]
              );
            else
              setSelected((previous) =>
                allSelected ? previous.filter((id) => !ids.includes(id)) : [...new Set([...previous, ...ids])]
              );
          }}
        >
          {allSelected ? t("clear") : t("selectAll")}
        </Button>
      </div>
    </div>
  );
}

export function ProductionBonusCheckoutPanelSection3({
  from,
  method,
  setFrom,
  setManualAmounts,
  setManualSelected,
  setMethod,
  setSelected,
  setTo,
  t,
  to,
}: Pick<
  ReturnType<typeof useProductionBonusCheckoutPanelState>,
  | "from"
  | "method"
  | "setFrom"
  | "setManualAmounts"
  | "setManualSelected"
  | "setMethod"
  | "setSelected"
  | "setTo"
  | "t"
  | "to"
>) {
  return (
    <div className="grid gap-3 rounded-xl border border-border/70 bg-card/60 p-4 sm:grid-cols-2 xl:grid-cols-3">
      <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
        {t("fromDate")}
        <Input
          aria-label={t("fromDate")}
          type="date"
          value={from}
          onChange={(event) => {
            setFrom(event.target.value);
            setSelected([]);
            setManualSelected([]);
            setManualAmounts({});
          }}
          className="h-10"
        />
      </label>
      <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
        {t("toDate")}
        <Input
          aria-label={t("toDate")}
          type="date"
          value={to}
          onChange={(event) => {
            setTo(event.target.value);
            setSelected([]);
            setManualSelected([]);
            setManualAmounts({});
          }}
          className="h-10"
        />
      </label>
      <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
        {t("method")}
        <Select
          value={method}
          onValueChange={(value) => {
            setMethod(value as Method);
            setSelected([]);
          }}
        >
          <SelectTrigger className="h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">{t("standard")}</SelectItem>
            <SelectItem value="category">{t("category")}</SelectItem>
          </SelectContent>
        </Select>
      </label>
    </div>
  );
}

export function ProductionBonusCheckoutPanelSection4({
  manualMode,
  setManualMode,
  setShowAll,
}: Pick<ReturnType<typeof useProductionBonusCheckoutPanelState>, "manualMode" | "setManualMode" | "setShowAll">) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3">
      <span className="mr-2 text-sm font-semibold">Payment type</span>
      <Button
        type="button"
        size="sm"
        variant={manualMode ? "default" : "outline"}
        onClick={() => {
          setManualMode(true);
          setShowAll(true);
        }}
      >
        Enter amount to pay
      </Button>
      <Button
        type="button"
        size="sm"
        variant={!manualMode ? "default" : "outline"}
        onClick={() => setManualMode(false)}
      >
        Calculated daily bonus
      </Button>
      <span className="text-xs text-muted-foreground">
        {manualMode
          ? "Select anyone in the sheet and enter a USD amount."
          : "Only approved/eligible calculated daily bonuses can be selected."}
      </span>
    </div>
  );
}
