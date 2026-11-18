// Extracted from ./ProductionBonusCheckoutPanel.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText, type ProductionBonusTranslationKey } from "@/i18n/factoryProductionBonusCheckoutTranslations";
import { queryClient } from "@/lib/queryClient";
import { localDateStr } from "../factoryProductionTargetsModel";
import type { ManualBonusHistory } from "./ProductionBonusManualPaymentPanel";
import { isProductionWorkday, mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import {
  daysApart,
  endpoint,
  isDate,
  payableStatus,
  request,
  startOfRange,
  summarizeByWorker,
  type Account,
  type Method,
  type Offer,
  type PaymentRow,
  type Preview,
} from "./ProductionBonusCheckoutPanelSummarizeByWorker";

export function useProductionBonusCheckoutPanelState({ initialDate }: { initialDate: string }) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const { language } = useApplicationLanguage();
  const t = (key: ProductionBonusTranslationKey) => bonusText(key, language);
  const [from, setFrom] = useState(() => startOfRange(initialDate));
  const [to, setTo] = useState(initialDate);
  const [method, setMethod] = useState<Method>("standard");
  const [selected, setSelected] = useState<number[]>([]);
  const [manualMode, setManualMode] = useState(true);
  const [manualSelected, setManualSelected] = useState<number[]>([]);
  const [manualAmounts, setManualAmounts] = useState<Record<number, string>>({});
  const [showAll, setShowAll] = useState(true);
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => localDateStr(new Date()));
  const [confirmPay, setConfirmPay] = useState(false);
  const [editingRate, setEditingRate] = useState<Offer | null>(null);
  const [newRate, setNewRate] = useState("");
  const [reverse, setReverse] = useState<PaymentRow | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  useEffect(() => {
    setFrom(startOfRange(initialDate));
    setTo(initialDate);
    setSelected([]);
    setManualSelected([]);
    setManualAmounts({});
    setSearch("");
    setShowAll(true);
  }, [initialDate]);
  const validRange = isDate(from) && isDate(to) && from <= to && daysApart(from, to) <= 31;
  const { data: access } = useQuery<{ canDecide: boolean }>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses", from, from],
    queryFn: () =>
      request(
        "GET",
        "/api/factory/staff-tracking/production-bonuses?" + new URLSearchParams({ start: from, end: from })
      ),
    enabled: validRange,
  });
  const canUse = access?.canDecide === true;
  const { data, error, isLoading } = useQuery<Preview>({
    queryKey: [endpoint, from, to, method],
    queryFn: () => request("GET", endpoint + "?" + new URLSearchParams({ from, to, method })),
    enabled: canUse && validRange,
  });
  const { data: accounts } = useQuery<{ accounts: Account[] }>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses/payment-accounts"],
    queryFn: () => request("GET", "/api/factory/staff-tracking/production-bonuses/payment-accounts"),
    enabled: canUse,
  });
  const { data: payments } = useQuery<{ payments: PaymentRow[] }>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses/payments", from, to],
    queryFn: () =>
      request(
        "GET",
        "/api/factory/staff-tracking/production-bonuses/payments?" + new URLSearchParams({ start: from, end: to })
      ),
    enabled: canUse && validRange,
  });
  const manualWeekStart = mondayOfProductionBonusWeek(to) ?? "";
  const { data: manualHistory } = useQuery<ManualBonusHistory>({
    queryKey: ["/api/factory/production-target-bonuses/checkout/manual-payments", manualWeekStart],
    queryFn: () =>
      request(
        "GET",
        "/api/factory/production-target-bonuses/checkout/manual-payments?" +
          new URLSearchParams({ weekStart: manualWeekStart })
      ),
    enabled: canUse && Boolean(manualWeekStart),
  });
  const manuallyPaidIds = (manualHistory?.payments ?? [])
    .filter((row) => row.status === "POSTED")
    .map((row) => row.workerId);
  const cashAccounts = (accounts?.accounts ?? []).filter(
    (a) => !a.openingCurrency || a.openingCurrency.toUpperCase() === "USD"
  );
  // Sunday is a factory holiday; stale cached API data must never enable Sunday payout.
  const offers = (data?.offers ?? []).filter((row) => isProductionWorkday(row.date));
  const groups = useMemo(() => summarizeByWorker(offers), [offers]);
  const chosen = useMemo(
    () => offers.filter((row) => selected.includes(row.workerId) && payableStatus(row)),
    [offers, selected]
  );
  const selectedGroups = groups.filter((group) => selected.includes(group.workerId) && group.readyDays > 0);
  const total = chosen.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;
  const payableGroups = groups.filter((group) => group.readyDays > 0);
  const includesWeeklyBonuses = groups.some((group) => group.weeklyDays > 0);
  const projectedWeeklyWorkers = groups.filter((group) => group.weeklyProjected).length;
  const searchTerm = search.trim().toLocaleLowerCase();
  const matchingGroups = groups.filter((group) => group.workerName.toLocaleLowerCase().includes(searchTerm));
  const matchingLinkIds = new Set(
    matchingGroups.flatMap((group) => group.days.map((day) => day.linkGroupId).filter((id): id is number => id != null))
  );
  // A name search retains linked teammates so the relationship stays visible.
  const visibleGroups = groups.filter(
    (group) =>
      (manualMode || showAll || group.readyDays > 0) &&
      (group.workerName.toLocaleLowerCase().includes(searchTerm) ||
        (searchTerm !== "" &&
          group.days.some((day) => day.linkGroupId != null && matchingLinkIds.has(day.linkGroupId))))
  );
  const visiblePayableGroups = visibleGroups.filter((group) => group.readyDays > 0);
  const manualSelectableGroups = visibleGroups.filter((group) => !manuallyPaidIds.includes(group.workerId));
  const selectableGroups = manualMode ? manualSelectableGroups : visiblePayableGroups;
  const activeSelection = manualMode ? manualSelected : selected;
  const allSelected =
    selectableGroups.length > 0 && selectableGroups.every((group) => activeSelection.includes(group.workerId));
  const tooMany = chosen.length > 100;
  const pay = useMutation({
    mutationFn: () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return request<{ posted: number; replayed: number }>("POST", endpoint + "/pay", {
        // data-no-translate: TypeScript generic, not user-visible JSX
        method,
        rosterDate: to,
        confirm: true,
        currency: "USD",
        paymentDate,
        cashAccountId: Number(accountId),
        selections: chosen.map((row) => ({
          date: row.date,
          workerId: row.workerId,
          expectedAmount: row.amount,
          token: row.token,
        })),
      });
    },
    onSuccess: (result) => {
      setConfirmPay(false);
      setSelected([]);
      toast({
        title: t("paidToast"),
        description: result.posted + " " + t("paidDesc") + " " + result.replayed + " " + t("retryDesc"),
      });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/report"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-bonuses"] });
    },
    onError: (error: Error) => {
      setConfirmPay(false);
      toast({ title: t("payFailed"), description: error.message, variant: "destructive" });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
    },
  });
  const saveRate = useMutation({
    mutationFn: () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return request("POST", "/api/factory/staff-tracking/production-bonuses/rate", {
        workerId: editingRate!.workerId,
        effectiveFrom: localDateStr(new Date()),
        ratePerBale: newRate,
      });
    },
    onSuccess: () => {
      setEditingRate(null);
      toast({ title: t("rateSaved") });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
    },
    onError: (error: Error) => toast({ title: t("rateFailed"), description: error.message, variant: "destructive" }),
  });
  const reverseMutation = useMutation({
    mutationFn: () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return request(
        "POST",
        "/api/factory/staff-tracking/production-bonuses/payments/" + reverse!.paymentId + "/reverse",
        {
          confirm: true,
          reversalDate: paymentDate,
          reason: reverseReason,
        }
      );
    },
    onSuccess: () => {
      setReverse(null);
      setReverseReason("");
      toast({ title: t("reversedToast") });
      void queryClient.invalidateQueries({ queryKey: [endpoint] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses/payments"] });
    },
    onError: (error: Error) => toast({ title: t("reverseFailed"), description: error.message, variant: "destructive" }),
  });
  return {
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
  };
}
