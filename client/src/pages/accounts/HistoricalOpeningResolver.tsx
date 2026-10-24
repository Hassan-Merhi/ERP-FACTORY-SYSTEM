import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";

interface UnresolvedOpening {
  entity_type: "ledger" | "bank" | "customer" | "supplier" | "employee" | "fixedAsset";
  id: number;
  name: string;
  code: string;
  raw_amount: string;
  side: "Dr" | "Cr";
}

interface Draft {
  currency: "USD" | "CFA" | "ZMW";
  historicalRate: string;
}

export function HistoricalOpeningResolver() {
  const { toast } = useToast();
  const { displayCurrency } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // A draft choice and a previously cached unresolved balance must not leak
  // across company switches. Rate and opening amount are tenant data.
  useEffect(() => {
    setDrafts({});
  }, [companyId]);
  const query = useQuery<UnresolvedOpening[]>({
    queryKey: ["/api/accounts/multi-currency/unresolved-openings", companyId],
    enabled: !!companyId,
    staleTime: 30_000,
  });

  const rows = useMemo(() => query.data || [], [query.data]);
  const rowKeys = useMemo(() => new Set(rows.map((row) => `${row.entity_type}:${row.id}`)), [rows]);

  const mutation = useMutation({
    mutationFn: async ({ row, draft }: { row: UnresolvedOpening; draft: Draft }) => {
      return apiRequest("PUT", `/api/accounts/multi-currency/opening-balance/${row.entity_type}/${row.id}`, {
        nativeAmount: row.raw_amount,
        currency: draft.currency,
        historicalRate: draft.currency !== "USD" ? draft.historicalRate : "1",
        side: row.side,
      });
    },
    onSuccess: (_data, variables) => {
      toast({
        title: "Historical value resolved",
        description: `${variables.row.name} now preserves its native amount and historical base value.`,
      });
      const key = `${variables.row.entity_type}:${variables.row.id}`;
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/multi-currency/unresolved-openings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/multi-currency/readiness"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/multi-currency/cash-bank-revaluation"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: "Could not resolve historical value",
        description: error?.message || "Check the currency and historical rate.",
        variant: "destructive",
      });
    },
  });

  if (query.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking historical opening values…
        </CardContent>
      </Card>
    );
  }

  if (query.error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Historical values unavailable</AlertTitle>
        <AlertDescription>
          {query.error instanceof Error ? query.error.message : "Unable to load unresolved values."}
        </AlertDescription>
      </Alert>
    );
  }

  if (rows.length === 0) {
    return (
      <Alert>
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>Opening and acquisition values resolved</AlertTitle>
        <AlertDescription>
          No unresolved ledger, bank, customer, supplier, employee, or fixed-asset values remain.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card data-testid="historical-opening-resolver">
      <CardHeader>
        <CardTitle className="text-base">Resolve Historical Opening & Asset Values</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Manual review required</AlertTitle>
          <AlertDescription>
            Choose the currency originally entered and its historical foreign-units-per-USD rate (for Zambia, ZMW per
            USD). This preserves the native amount and a separate historical USD value. Do not enter today's rate unless
            it truly applied to the original opening.
          </AlertDescription>
        </Alert>

        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Original raw amount</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Historical rate</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const key = `${row.entity_type}:${row.id}`;
                const draft = drafts[key] || { currency: "USD" as const, historicalRate: "" };
                const isSaving =
                  mutation.isPending &&
                  mutation.variables?.row.entity_type === row.entity_type &&
                  mutation.variables?.row.id === row.id;
                const invalidRate =
                  draft.currency !== "USD" &&
                  (!draft.historicalRate ||
                    !Number.isFinite(Number(draft.historicalRate)) ||
                    Number(draft.historicalRate) <= 0);
                return (
                  <TableRow key={key}>
                    <TableCell className="capitalize">
                      {row.entity_type === "fixedAsset" ? "Fixed asset" : row.entity_type}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{row.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.code || `#${row.id}`} · {row.side}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono">{Number(row.raw_amount || 0).toLocaleString()}</TableCell>
                    <TableCell className="min-w-[120px]">
                      <Select
                        value={draft.currency}
                        onValueChange={(currency) => {
                          if (currency !== "USD" && currency !== displayCurrency) return;
                          if (currency !== "USD" && currency !== "CFA" && currency !== "ZMW") return;
                          setDrafts((current) => ({ ...current, [key]: { ...draft, currency } }));
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          {displayCurrency === "CFA" && <SelectItem value="CFA">CFA</SelectItem>}
                          {displayCurrency === "ZMW" && <SelectItem value="ZMW">ZMW — Kwacha</SelectItem>}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="min-w-[170px]">
                      {draft.currency !== "USD" ? (
                        <div className="space-y-1">
                          <Label className="sr-only">Historical {draft.currency} per USD rate</Label>
                          <Input
                            type="number"
                            min="0.0000000001"
                            step="0.0000000001"
                            placeholder="e.g. 600"
                            value={draft.historicalRate}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [key]: { ...draft, historicalRate: event.target.value },
                              }))
                            }
                          />
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">1.0000000000</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        disabled={isSaving || invalidRate || !rowKeys.has(key)}
                        onClick={() => mutation.mutate({ row, draft })}
                      >
                        {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Resolve
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
