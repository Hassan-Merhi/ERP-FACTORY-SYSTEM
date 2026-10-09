import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link2, Loader2, Unlink2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { evenSplitBales } from "@shared/factoryProductionTargetSplit";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  translateFactoryStaffTrackingText,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { ProductionRow } from "../factoryProductionTargetsModel";

interface ProductionWorkerLinkControlProps {
  row: ProductionRow;
  rows: ProductionRow[];
  effectiveFrom: string;
  targetBales?: number | null;
  disabled?: boolean;
}

const MAX_LINKED_WORKERS = 10;

export function ProductionWorkerLinkControl({
  row,
  rows,
  effectiveFrom,
  targetBales,
  disabled = false,
}: ProductionWorkerLinkControlProps) {
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
      : row.linkedWorkers?.map((member) => member.workerId) ?? [];
    return [...new Set([row.personId, ...linkedIds])];
  }, [row.personId, row.linkedWorkerIds, row.linkedWorkers]);

  const remainingSlots = Math.max(0, MAX_LINKED_WORKERS - currentMemberIds.length);

  const unlinkMembers = useMemo(
    () => currentMemberIds
      .map((workerId) => ({
        workerId,
        name: rows.find((candidate) => candidate.personId === workerId)?.name ??
          row.linkedWorkers?.find((member) => member.workerId === workerId)?.workerName ??
          String(workerId),
      }))
      .sort((a, b) => a.workerId - b.workerId),
    [currentMemberIds, rows, row.linkedWorkers]
  );

  const allocatedTotal = unlinkMembers.reduce((sum, member) => {
    const value = unlinkDraft[member.workerId];
    return sum + (value === "" || value === undefined ? 0 : Number(value));
  }, 0);
  const validSplit = unlinkTarget === null ||
    (Number.isSafeInteger(unlinkTarget) && unlinkTarget >= 0 &&
      unlinkMembers.every((member) => {
        const value = unlinkDraft[member.workerId];
        return value !== "" && value !== undefined &&
          Number.isSafeInteger(Number(value)) && Number(value) >= 0;
      }) && allocatedTotal === unlinkTarget);

  const fillEvenSplit = (total: number) => {
    const split = evenSplitBales(total, currentMemberIds);
    setUnlinkDraft(Object.fromEntries(split.map((share) => [share.workerId, String(share.targetBales)])));
  };

  const openUnlinkDialog = () => {
    const shared = targetBales === undefined ? (row.targetBales ?? null) : targetBales;
    setUnlinkTarget(shared ?? null);
    if (shared !== null && shared !== undefined && Number.isSafeInteger(shared) && shared >= 0) {
      fillEvenSplit(shared);
    } else {
      setUnlinkDraft({});
    }
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
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
      );
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

      const sharedTargetBales =
        targetBales === undefined
          ? (row.targetBales ?? partners.find((partner) => partner.targetBales != null)?.targetBales ?? null)
          : targetBales;
      const response = await factoryApiRequest(
        "POST",
        "/api/factory/staff-tracking/production-worker-links",
        {
          effectiveFrom,
          workerIds,
          targetBales: sharedTargetBales,
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
          ...(unlinkTarget === null ? {} : {
            allocations: unlinkMembers.map((member) => ({
              workerId: member.workerId,
              targetBales: Number(unlinkDraft[member.workerId]),
            })),
          }),
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

  if (!selectingPartners) {
    return (
      <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled || busy || !canAddPartners}
          onClick={() => setSelectingPartners(true)}
          data-testid={`button-link-worker-${row.personId}`}
        >
          <Link2 className="mr-1 h-3 w-3" />
          {tr("linkWorker")}
        </Button>
        {row.linkGroupId != null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={disabled || busy}
            onClick={openUnlinkDialog}
            data-testid={`button-unlink-worker-${row.personId}`}
          >
            {unlinkMutation.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Unlink2 className="mr-1 h-3 w-3" />
            )}
            {tr("unlink")}
          </Button>
        )}
      </div>
      <Dialog open={unlinkOpen} onOpenChange={(open) => !busy && setUnlinkOpen(open)}>
        <DialogContent className="max-w-md" data-testid={`dialog-unlink-target-${row.personId}`}>
          <DialogHeader>
            <DialogTitle>{tr("unlinkSplitTitle")}</DialogTitle>
            <DialogDescription>{tr("unlinkSplitDescription")}</DialogDescription>
          </DialogHeader>
          {unlinkTarget === null ? (
            <p className="text-sm text-muted-foreground">{tr("unlinkSplitNoTarget")}</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold tabular-nums">{tr("totalTarget")}: {unlinkTarget}</span>
                <Button type="button" variant="outline" size="sm"
                  disabled={busy || !Number.isSafeInteger(unlinkTarget) || unlinkTarget < 0}
                  onClick={() => fillEvenSplit(unlinkTarget)}
                  data-testid={`button-even-split-${row.personId}`}>
                  {tr("unlinkSplitAuto")}
                </Button>
              </div>
              {unlinkMembers.map((member) => (
                <div key={member.workerId} className="flex items-center gap-3">
                  <label className="min-w-0 flex-1 truncate text-sm" dir="auto"
                    htmlFor={`unlink-target-${row.personId}-${member.workerId}`}>
                    {member.name}
                  </label>
                  <Input
                    id={`unlink-target-${row.personId}-${member.workerId}`}
                    type="number"
                    min="0"
                    step="1"
                    className="w-24 text-right tabular-nums"
                    disabled={busy}
                    value={unlinkDraft[member.workerId] ?? ""}
                    onChange={(event) => setUnlinkDraft((current) => ({
                      ...current,
                      [member.workerId]: event.target.value,
                    }))}
                    data-testid={`input-unlink-target-${member.workerId}`}
                  />
                </div>
              ))}
              <div className="text-sm font-medium tabular-nums">
                {tr("unlinkSplitAllocated")}: {allocatedTotal} / {unlinkTarget}
              </div>
              {!validSplit && (
                <p className="text-xs text-destructive" role="alert">{tr("unlinkSplitWholeBales")}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy}
              onClick={() => setUnlinkOpen(false)}>{tr("cancel")}</Button>
            <Button type="button" disabled={busy || !validSplit}
              onClick={() => unlinkMutation.mutate()}
              data-testid={`button-confirm-unlink-${row.personId}`}>
              {unlinkMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tr("unlinkSplitConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </>
    );
  }

  return (
    <div className="space-y-1.5">
      {selectedPartners.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`selected-link-partners-${row.personId}`}>
          {selectedPartners.map((partner) => (
            <Badge key={partner.personId} variant="secondary" className="gap-1 pr-1 text-[11px] font-normal">
              <span dir="auto">{partner.name}</span>
              <button
                type="button"
                className="rounded-sm p-0.5 hover:bg-muted"
                disabled={disabled || busy}
                onClick={() =>
                  setSelectedPartnerIds((current) => current.filter((workerId) => workerId !== partner.personId))
                }
                aria-label={`${tr("unlink")} ${partner.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={partnerSelectValue}
          onValueChange={(value) => {
            const partnerId = Number(value);
            if (!Number.isInteger(partnerId) || selectedPartnerIds.includes(partnerId)) return;
            setSelectedPartnerIds((current) => [...current, partnerId].slice(0, remainingSlots));
            setPartnerSelectValue("");
          }}
        >
          <SelectTrigger
            className="h-7 min-w-[150px] text-xs"
            disabled={disabled || busy || selectedPartnerIds.length >= remainingSlots || partnerOptions.length === 0}
            data-testid={`select-link-partner-${row.personId}`}
          >
            <SelectValue placeholder={tr("chooseWorker")} />
          </SelectTrigger>
          <SelectContent>
            {partnerOptions.map((candidate) => (
              <SelectItem key={candidate.personId} value={String(candidate.personId)}>
                <span dir="auto">{candidate.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled || busy || selectedPartnerIds.length === 0}
          onClick={() => linkMutation.mutate(selectedPartnerIds)}
          data-testid={`button-save-worker-links-${row.personId}`}
        >
          {linkMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : tr("link")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled || busy}
          onClick={resetSelection}
        >
          {tr("cancel")}
        </Button>
      </div>
    </div>
  );
}
