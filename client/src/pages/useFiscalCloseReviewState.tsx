// Extracted from ./FiscalCloseReview.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  defaultStart,
  read,
  root,
  type AuditHistory,
  type CloseHistory,
  type EquityAccounts,
  type Readiness,
  type ReviewKind,
  type ReviewPolicy,
} from "./FiscalCloseReviewTypes";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export function useFiscalCloseReviewState() {
  const { selectedCompany } = useCompany(),
    companyId = selectedCompany?.id;
  const { toast } = useToast(),
    client = useQueryClient();
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState("");
  const [retainedId, setRetainedId] = useState("");
  const [reviewKind, setReviewKind] = useState<ReviewKind>("ACCOUNTING");
  const [note, setNote] = useState("");
  const [archiveReason, setArchiveReason] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [tab, setTab] = useState<"readiness" | "signoffs" | "history" | "audit">("readiness");
  const [policyReason, setPolicyReason] = useState("");
  const [policyConfirm, setPolicyConfirm] = useState("");
  const params = new URLSearchParams({
    periodStartDate: start,
    periodEndDate: end,
    retainedEarningsAccountId: retainedId,
  });
  const canQuery = !!companyId && !!start && !!end && Number(retainedId) > 0;
  const accounts = useQuery<EquityAccounts>({
    queryKey: [root + "/equity-accounts", companyId],
    queryFn: () => read(root + "/equity-accounts"),
    enabled: !!companyId,
    retry: false,
  });
  const policy = useQuery<ReviewPolicy>({
    queryKey: [root + "/policy", companyId],
    queryFn: () => read(root + "/policy"),
    enabled: !!companyId,
    retry: false,
  });
  const readiness = useQuery<Readiness>({
    queryKey: [root + "/readiness", companyId, start, end, retainedId],
    queryFn: () => read(root + "/readiness?" + params.toString()),
    enabled: canQuery,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const history = useQuery<CloseHistory>({
    queryKey: [root + "/history", companyId],
    queryFn: () => read(root + "/history"),
    enabled: !!companyId && tab === "history",
    retry: false,
  });
  const audit = useQuery<AuditHistory>({
    queryKey: [root + "/audit", companyId],
    queryFn: () => read(root + "/audit"),
    enabled: !!companyId && tab === "audit",
    retry: false,
  });
  const data = readiness.data;
  const hasCurrent = useMemo(() => data?.signoffs.filter((x) => x.current) ?? [], [data]);
  const reviewHash = data?.evidenceHash ?? "";
  const onError = (error: Error) =>
    toast({ title: "Fiscal review refused", description: error.message, variant: "destructive" });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: [root + "/readiness"] }),
      client.invalidateQueries({ queryKey: [root + "/history"] }),
      client.invalidateQueries({ queryKey: [root + "/audit"] }),
      client.invalidateQueries({ queryKey: [root + "/policy"] }),
    ]);
  };
  const changePolicy = useMutation({
    mutationFn: async (enforce: boolean) => {
      const response = await apiRequest("POST", root + "/policy", {
        enforce,
        reason: policyReason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Fiscal review requirement updated and audited" });
      setPolicyReason("");
      setPolicyConfirm("");
      await refresh();
    },
    onError,
  });
  const signoff = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", root + "/signoffs", {
        periodStartDate: start,
        periodEndDate: end,
        retainedEarningsAccountId: Number(retainedId),
        evidenceHash: reviewHash,
        reviewKind,
        note,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Independent review recorded" });
      setNote("");
      await refresh();
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("POST", root + "/signoffs/" + id + "/revoke", {
        reason: archiveReason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({ title: "Review revoked with audit reason" });
      setArchiveReason("");
      await refresh();
    },
    onError,
  });
  const closeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", root + "/close", {
        periodStartDate: start,
        periodEndDate: end,
        retainedEarningsAccountId: Number(retainedId),
        evidenceHash: reviewHash,
        notes: closeNote || undefined,
      });
      return response.json();
    },
    onSuccess: async (result: { closingVoucherId: number }) => {
      toast({
        title: "Reviewed fiscal close posted",
        description: "Original fiscal-close engine posted voucher #" + result.closingVoucherId,
      });
      setConfirmText("");
      setCloseNote("");
      await refresh();
    },
    onError,
  });
  const yes = (x: boolean) => (x ? "Installed" : "Missing / disabled");
  return {
    accounts,
    archiveReason,
    audit,
    canQuery,
    changePolicy,
    closeMutation,
    closeNote,
    confirmText,
    data,
    end,
    hasCurrent,
    history,
    note,
    policy,
    policyConfirm,
    policyReason,
    readiness,
    retainedId,
    reviewKind,
    revoke,
    selectedCompany,
    setArchiveReason,
    setCloseNote,
    setConfirmText,
    setEnd,
    setNote,
    setPolicyConfirm,
    setPolicyReason,
    setRetainedId,
    setReviewKind,
    setStart,
    setTab,
    signoff,
    start,
    tab,
    yes,
  };
}

export function FiscalCloseReviewCardSection({
  accounts,
  canQuery,
  data,
  end,
  readiness,
  retainedId,
  setConfirmText,
  setEnd,
  setRetainedId,
  setStart,
  start,
}: Pick<
  ReturnType<typeof useFiscalCloseReviewState>,
  | "accounts"
  | "canQuery"
  | "data"
  | "end"
  | "readiness"
  | "retainedId"
  | "setConfirmText"
  | "setEnd"
  | "setRetainedId"
  | "setStart"
  | "start"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Period and retained earnings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Period begins</Label>
            <Input
              type="date"
              value={start}
              onChange={(v) => {
                setStart(v.target.value);
                setConfirmText("");
              }}
            />
          </div>
          <div>
            <Label>Period ends</Label>
            <Input
              type="date"
              value={end}
              onChange={(v) => {
                setEnd(v.target.value);
                setConfirmText("");
              }}
            />
          </div>
          <div>
            <Label>Existing Retained Earnings / Equity account</Label>
            <Select
              value={retainedId || "__none__"}
              onValueChange={(value) => {
                setRetainedId(value === "__none__" ? "" : value);
                setConfirmText("");
              }}
            >
              <SelectTrigger className="h-10 w-full" aria-label="Existing Retained Earnings / Equity account">
                <SelectValue placeholder="Select an active Equity account" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select an active Equity account</SelectItem>
                {accounts.data?.accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.code} · {a.name} (#{a.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {accounts.isError && <p className="text-xs text-destructive">Unable to list existing Equity accounts</p>}
          </div>
        </div>
        {data?.history.latestClosedEnd && (
          <p className="text-sm text-muted-foreground">
            Latest closed period ends {data.history.latestClosedEnd}. Next period must begin{" "}
            {data.history.expectedNextStart}.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Only an existing active Equity account from this company is accepted. No account is created automatically. For
          date periods that are still open, review only; a close cannot include today.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!canQuery || readiness.isFetching} onClick={() => readiness.refetch()}>
            Refresh financial evidence
          </Button>
          <span className="text-xs text-muted-foreground">
            Every refresh recalculates the evidence fingerprint from the current posted ledger.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
