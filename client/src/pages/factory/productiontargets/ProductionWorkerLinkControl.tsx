import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link2, Loader2, Unlink2 } from "lucide-react";
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
  const [selectingPartner, setSelectingPartner] = useState(false);
  const [selectedPartnerId, setSelectedPartnerId] = useState("");

  const partnerOptions = useMemo(
    () =>
      rows
        .filter(
          (candidate) =>
            candidate.personId !== row.personId &&
            candidate.active &&
            candidate.linkGroupId == null
        )
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
        ),
    [row.personId, rows]
  );

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
    mutationFn: async (partnerId: number) => {
      const partner = rows.find((candidate) => candidate.personId === partnerId);
      if (!partner) throw new Error(tr("workerLinkFailed"));

      const response = await factoryApiRequest(
        "POST",
        "/api/factory/staff-tracking/production-worker-links",
        {
          effectiveFrom,
          workerIds: [row.personId, partnerId],
          targetBales: targetBales ?? row.targetBales ?? partner.targetBales ?? null,
        }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("workerLinkFailed"));
      }
      return response.json();
    },
    onSuccess: () => {
      setSelectingPartner(false);
      setSelectedPartnerId("");
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
      setSelectingPartner(false);
      setSelectedPartnerId("");
      refreshLinkedProduction();
      toast({ title: tr("workerUnlinked") });
    },
    onError: (error: Error) => {
      toast({ title: tr("workerLinkFailed"), description: error.message, variant: "destructive" });
    },
  });

  const busy = linkMutation.isPending || unlinkMutation.isPending;

  if (row.linkGroupId != null) {
    return (
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
    );
  }

  if (!selectingPartner) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={disabled || busy || partnerOptions.length === 0}
        onClick={() => setSelectingPartner(true)}
        data-testid={`button-link-worker-${row.personId}`}
      >
        <Link2 className="mr-1 h-3 w-3" />
        {tr("linkWorker")}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={selectedPartnerId} onValueChange={setSelectedPartnerId}>
        <SelectTrigger
          className="h-7 min-w-[150px] text-xs"
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
        disabled={disabled || busy || !selectedPartnerId}
        onClick={() => linkMutation.mutate(Number(selectedPartnerId))}
      >
        {linkMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : tr("link")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={disabled || busy}
        onClick={() => {
          setSelectingPartner(false);
          setSelectedPartnerId("");
        }}
      >
        {tr("cancel")}
      </Button>
    </div>
  );
}
