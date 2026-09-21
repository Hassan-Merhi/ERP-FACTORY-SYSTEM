import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  translateFactoryStaffTrackingText,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { ProductionRow } from "../factoryProductionTargetsModel";

interface ProductionTargetDefaultsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ProductionRow[];
  effectiveFrom: string;
}

interface TargetDefaultsResponse {
  asOf: string;
  targets: Array<{ workerId: number; targetBales: number | null }>;
}

function targetValue(value: string): number | null {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function ProductionTargetDefaultsDialog({
  open,
  onOpenChange,
  rows,
  effectiveFrom,
}: ProductionTargetDefaultsDialogProps) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const [draftTargets, setDraftTargets] = useState<Record<number, number | null>>({});
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery<TargetDefaultsResponse>({
    queryKey: ["/api/factory/staff-tracking/production-target-defaults", effectiveFrom],
    queryFn: async () => {
      const params = new URLSearchParams({ asOf: effectiveFrom });
      const response = await factoryApiRequest(
        "GET",
        `/api/factory/staff-tracking/production-target-defaults?${params.toString()}`
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("loadFailed"));
      }
      return response.json();
    },
    enabled: open && Boolean(effectiveFrom),
  });

  const defaultsById = useMemo(
    () => new Map((data?.targets ?? []).map((entry) => [entry.workerId, entry.targetBales])),
    [data]
  );

  useEffect(() => {
    if (!open || !data) return;
    setDraftTargets(Object.fromEntries(rows.map((row) => [row.personId, defaultsById.get(row.personId) ?? null])));
    setSearch("");
  }, [open, data, defaultsById, rows]);

  const changedRecords = useMemo(
    () =>
      rows
        .filter((row) => (draftTargets[row.personId] ?? null) !== (defaultsById.get(row.personId) ?? null))
        .map((row) => ({
          workerId: row.personId,
          targetBales: draftTargets[row.personId] ?? null,
        })),
    [rows, draftTargets, defaultsById]
  );

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return [...rows]
      .filter(
        (row) =>
          !needle ||
          row.name.toLocaleLowerCase().includes(needle) ||
          (row.code || "").toLocaleLowerCase().includes(needle) ||
          row.category.toLocaleLowerCase().includes(needle)
      )
      .sort((left, right) => {
        const categoryCompare = left.category.localeCompare(right.category, undefined, {
          sensitivity: "base",
          numeric: true,
        });
        if (categoryCompare !== 0) return categoryCompare;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
      });
  }, [rows, search]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await factoryApiRequest("POST", "/api/factory/staff-tracking/production-target-defaults", {
        effectiveFrom,
        records: changedRecords,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("saveDataFailed"));
      }
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/staff-tracking"],
        refetchType: "active",
      });
      toast({ title: tr("defaultTargetsSaved") });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({ title: tr("saveFailed"), description: error.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saveMutation.isPending && onOpenChange(nextOpen)}>
      <DialogContent
        className="flex h-[88vh] w-[calc(100vw-1rem)] max-w-[980px] flex-col gap-0 overflow-hidden p-0"
        data-testid="dialog-production-target-defaults"
      >
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3 pr-7">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" />
                {tr("defaultTargets")}
              </DialogTitle>
              <DialogDescription className="mt-1">{tr("defaultTargetsDescription")}</DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{effectiveFrom}</Badge>
              {changedRecords.length > 0 && (
                <Badge variant="secondary" data-testid="badge-production-default-changes">
                  {changedRecords.length} {tr("changes")}
                </Badge>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="shrink-0 border-b px-5 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tr("searchNameCodeCategory")}
              className="pl-9"
              data-testid="input-production-default-search"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <Table wrapperClassName="overflow-visible rounded-none border-0">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="min-w-[230px]">{tr("person")}</TableHead>
                <TableHead className="min-w-[180px]">{tr("category")}</TableHead>
                <TableHead className="w-[170px] text-right">{tr("dailyDefaultTarget")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-12 text-center text-muted-foreground">
                    {tr("loadingStaff")}
                  </TableCell>
                </TableRow>
              ) : visibleRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-12 text-center text-muted-foreground">
                    {tr("noMatchingStaff")}
                  </TableCell>
                </TableRow>
              ) : (
                visibleRows.map((row) => (
                  <TableRow key={row.personId}>
                    <TableCell>
                      <div className="font-medium" dir="auto">
                        {row.name}
                      </div>
                    </TableCell>
                    <TableCell>{row.category || "—"}</TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={draftTargets[row.personId] ?? ""}
                        disabled={isLoading || saveMutation.isPending}
                        onChange={(event) =>
                          setDraftTargets((current) => ({
                            ...current,
                            [row.personId]: targetValue(event.target.value),
                          }))
                        }
                        className="text-right tabular-nums"
                        data-testid={`input-production-default-target-${row.personId}`}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="shrink-0 border-t px-5 py-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saveMutation.isPending}
            data-testid="button-cancel-production-defaults"
          >
            {tr("cancel")}
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={isLoading || changedRecords.length === 0 || saveMutation.isPending}
            data-testid="button-save-production-defaults"
          >
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saveMutation.isPending ? tr("saving") : tr("saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
