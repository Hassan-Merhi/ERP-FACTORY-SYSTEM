import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link2, Loader2, Unlink2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

  const currentMemberIds = useMemo(() => {
    const linkedIds = row.linkedWorkerIds?.length
      ? row.linkedWorkerIds
      : row.linkedWorkers?.map((member) => member.workerId) ?? [];
    return [...new Set([row.personId, ...linkedIds])];
  }, [row.personId, row.linkedWorkerIds, row.linkedWorkers]);

  const remainingSlots = Math.max(0, MAX_LINKED_WORKERS - currentMemberIds.length);

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
        { effectiveTo: effectiveFrom }
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
            onClick={() => unlinkMutation.mutate()}
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
