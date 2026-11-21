// Extracted from ./ProductionWorkerLinkControl.tsx
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { evenSplitBales, isValidBaleTarget } from "@shared/factoryProductionTargetSplit";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  translateFactoryStaffTrackingText,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { ProductionRow } from "../factoryProductionTargetsModel";

export interface ProductionWorkerLinkControlProps {
  row: ProductionRow;
  rows: ProductionRow[];
  effectiveFrom: string;
  disabled?: boolean;
}

const MAX_LINKED_WORKERS = 10;

export function useProductionWorkerLinkControlState({
  row,
  rows,
  effectiveFrom,
}: Pick<ProductionWorkerLinkControlProps, "row" | "rows" | "effectiveFrom">) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const [selectingPartners, setSelectingPartners] = useState(false);
  const [selectedPartnerIds, setSelectedPartnerIds] = useState<number[]>([]);
  const [partnerSelectValue, setPartnerSelectValue] = useState("");
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<number | null>(null);
  const [unlinkDraft, setUnlinkDraft] = useState<Record<number, string>>({});

  const currentMemberIds = useMemo(() => {
    const linkedIds = row.linkedWorkerIds?.length
      ? row.linkedWorkerIds
      : (row.linkedWorkers?.map((member) => member.workerId) ?? []);
    return [...new Set([row.personId, ...linkedIds])];
  }, [row.personId, row.linkedWorkerIds, row.linkedWorkers]);

  const remainingSlots = Math.max(0, MAX_LINKED_WORKERS - currentMemberIds.length);

  const unlinkMembers = useMemo(
    () =>
      currentMemberIds
        .map((workerId) => ({
          workerId,
          name:
            rows.find((candidate) => candidate.personId === workerId)?.name ??
            row.linkedWorkers?.find((member) => member.workerId === workerId)?.workerName ??
            String(workerId),
        }))
        .sort((a, b) => a.workerId - b.workerId),
    [currentMemberIds, rows, row.linkedWorkers]
  );

  const allocatedTotal = unlinkMembers.reduce((sum, member) => {
    const value = unlinkDraft[member.workerId];
    return sum + (value === "" || value === undefined ? 0 : Math.round(Number(value) * 100));
  }, 0);
  const validSplit =
    unlinkTarget === null ||
    (isValidBaleTarget(unlinkTarget) &&
      unlinkMembers.every((member) => {
        const value = unlinkDraft[member.workerId];
        return (
          value !== "" &&
          value !== undefined &&
          isValidBaleTarget(Number(value)) &&
          (!Number.isInteger(unlinkTarget) || Number.isInteger(Number(value)))
        );
      }) &&
      allocatedTotal === Math.round(unlinkTarget * 100));

  const fillEvenSplit = (total: number) => {
    const split = evenSplitBales(total, currentMemberIds);
    setUnlinkDraft(Object.fromEntries(split.map((share) => [share.workerId, String(share.targetBales)])));
  };

  const openUnlinkDialog = () => {
    // Start with each person's own repeating fixed target, never an average.
    const fixedTargets = currentMemberIds.map(
      (workerId) => rows.find((candidate) => candidate.personId === workerId)?.defaultTargetBales ?? null
    );
    const complete = fixedTargets.every((value) => value !== null && isValidBaleTarget(value));
    const combined = complete
      ? fixedTargets.reduce<number>((sum, value) => sum + Math.round((value ?? 0) * 100), 0) / 100
      : null;
    setUnlinkTarget(combined);
    setUnlinkDraft(
      complete
        ? Object.fromEntries(currentMemberIds.map((workerId, index) => [workerId, String(fixedTargets[index])]))
        : {}
    );
    setUnlinkOpen(true);
  };

  const partnerOptions = useMemo(() => {
    const currentIds = new Set(currentMemberIds);
    const selectedIds = new Set(selectedPartnerIds);
    return rows
      .filter(
        (candidate) =>
          !currentIds.has(candidate.personId) &&
          !selectedIds.has(candidate.personId) &&
          candidate.active &&
          candidate.linkGroupId == null
      )
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }));
  }, [currentMemberIds, rows, selectedPartnerIds]);

  const selectedPartners = useMemo(
    () =>
      selectedPartnerIds
        .map((workerId) => rows.find((candidate) => candidate.personId === workerId))
        .filter((candidate): candidate is ProductionRow => Boolean(candidate)),
    [rows, selectedPartnerIds]
  );

  const resetSelection = () => {
    setSelectingPartners(false);
    setSelectedPartnerIds([]);
    setPartnerSelectValue("");
  };

  const refreshLinkedProduction = () => {
    void queryClient.invalidateQueries({
      queryKey: ["/api/factory/staff-tracking"],
      refetchType: "active",
    });
    void queryClient.invalidateQueries({
      queryKey: ["/api/factory/staff-tracking/production-target-defaults"],
      refetchType: "active",
    });
  };

  const linkMutation = useMutation({
    mutationFn: async (partnerIds: number[]) => {
      const partners = partnerIds
        .map((partnerId) => rows.find((candidate) => candidate.personId === partnerId))
        .filter((candidate): candidate is ProductionRow => Boolean(candidate));
      if (partners.length !== partnerIds.length || partnerIds.length === 0) {
        throw new Error(tr("workerLinkFailed"));
      }

      const workerIds = [...new Set([...currentMemberIds, ...partnerIds])];
      if (workerIds.length < 2 || workerIds.length > MAX_LINKED_WORKERS) {
        throw new Error(tr("workerLinkFailed"));
      }

      const response = await factoryApiRequest("POST", "/api/factory/staff-tracking/production-worker-links", {
        effectiveFrom,
        workerIds,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("workerLinkFailed"));
      }
      return response.json();
    },
    onSuccess: () => {
      resetSelection();
      refreshLinkedProduction();
      toast({ title: tr("workerLinkSaved") });
    },
    onError: (error: Error) => {
      toast({ title: tr("workerLinkFailed"), description: error.message, variant: "destructive" });
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async () => {
      if (row.linkGroupId == null) throw new Error(tr("workerLinkFailed"));

      const response = await factoryApiRequest(
        "POST",
        `/api/factory/staff-tracking/production-worker-links/${row.linkGroupId}/unlink`,
        {
          effectiveTo: effectiveFrom,
          ...(unlinkTarget !== null &&
          unlinkMembers.some(
            (member) =>
              Number(unlinkDraft[member.workerId]) !==
              (rows.find((candidate) => candidate.personId === member.workerId)?.defaultTargetBales ?? null)
          )
            ? {
                allocations: unlinkMembers.map((member) => ({
                  workerId: member.workerId,
                  targetBales: Number(unlinkDraft[member.workerId]),
                })),
              }
            : {}),
        }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("workerLinkFailed"));
      }
      return response.json();
    },
    onSuccess: () => {
      resetSelection();
      setUnlinkOpen(false);
      refreshLinkedProduction();
      toast({ title: tr("workerUnlinked") });
    },
    onError: (error: Error) => {
      toast({ title: tr("workerLinkFailed"), description: error.message, variant: "destructive" });
    },
  });

  const busy = linkMutation.isPending || unlinkMutation.isPending;
  const canAddPartners = remainingSlots > 0 && partnerOptions.length > 0;
  return {
    tr,
    selectingPartners,
    setSelectingPartners,
    setSelectedPartnerIds,
    selectedPartnerIds,
    partnerSelectValue,
    setPartnerSelectValue,
    unlinkOpen,
    setUnlinkOpen,
    unlinkTarget,
    unlinkDraft,
    setUnlinkDraft,
    remainingSlots,
    unlinkMembers,
    allocatedTotal,
    validSplit,
    fillEvenSplit,
    openUnlinkDialog,
    partnerOptions,
    selectedPartners,
    resetSelection,
    linkMutation,
    unlinkMutation,
    busy,
    canAddPartners,
  };
}
