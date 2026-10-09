import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Banknote, LogIn, LogOut, Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { makeKey, money } from "./retailPosTypes";

export interface RetailShift {
  id: number;
  companyId: number;
  locationId: number;
  userId: string;
  username: string;
  cashAccountId: number | null;
  status: string;
  openingCash: string;
  closingCash?: string | null;
  expectedCash?: string | null;
  variance?: string | null;
  openedAt: string;
  closedAt?: string | null;
}

interface ShiftSummary {
  shift: RetailShift;
  salesCount: number;
  paymentMethods: Record<string, number>;
  cashSales: number;
  cashRefunds: number;
  cashIn: number;
  cashOut: number;
  expectedCash: number;
}

interface CashReason {
  reasonCode: string;
  label: string | null;
  direction: "cash_in" | "cash_out" | "either";
  source: "mapping" | "default" | "none";
}

interface CashReasonList {
  reasons: CashReason[];
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function RetailShiftPanel({
  locationId,
  onShiftChange,
}: {
  locationId: number | null;
  onShiftChange: (shift: RetailShift | null) => void;
}) {
  const { toast } = useToast();
  const [openingCash, setOpeningCash] = useState(0);
  const [closingCash, setClosingCash] = useState(0);
  const [movementAmount, setMovementAmount] = useState(0);
  const [movementReason, setMovementReason] = useState("");
  const [movementReasonCode, setMovementReasonCode] = useState("");

  const currentQuery = useQuery<RetailShift | null>({
    queryKey: ["retail-current-shift", locationId],
    queryFn: async () =>
      json<RetailShift | null>(
        await fetch(`/api/pos/shifts/current?locationId=${locationId}`, { credentials: "include" })
      ),
    enabled: Boolean(locationId),
    staleTime: 10_000,
  });

  // Wave 17 (D): each movement is journalled against the account its reason code maps to.
  const reasonsQuery = useQuery<CashReasonList>({
    queryKey: ["retail-cash-reasons"],
    queryFn: async () =>
      json<CashReasonList>(await fetch("/api/retail/financial/cash-reasons", { credentials: "include" })),
    enabled: Boolean(locationId),
    staleTime: 60_000,
  });

  const shift = currentQuery.data ?? null;
  useEffect(() => onShiftChange(shift), [shift, onShiftChange]);

  const historyQuery = useQuery<RetailShift[]>({
    queryKey: ["retail-shift-history", locationId],
    queryFn: async () =>
      json<RetailShift[]>(
        await fetch(`/api/pos/shifts/history?locationId=${locationId}&limit=5`, { credentials: "include" })
      ),
    enabled: Boolean(locationId),
    staleTime: 15_000,
  });

  const summaryQuery = useQuery<ShiftSummary>({
    queryKey: ["retail-shift-summary", shift?.id],
    queryFn: async () =>
      json<ShiftSummary>(await fetch(`/api/pos/retail/shifts/${shift!.id}/summary`, { credentials: "include" })),
    enabled: Boolean(shift?.id),
    staleTime: 5_000,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retail-current-shift"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-shift-summary"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-shift-history"] }),
    ]);
  };

  const openMutation = useMutation({
    mutationFn: async () => {
      if (!locationId) throw new Error("Select a selling location first");
      const response = await apiRequest("POST", "/api/pos/shifts/open", {
        locationId,
        openingCash,
      });
      return response.json();
    },
    onSuccess: async () => {
      await refresh();
      toast({ title: "Cashier shift opened" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not open shift", description: error.message, variant: "destructive" }),
  });

  const movementMutation = useMutation({
    mutationFn: async (movementType: "cash_in" | "cash_out") => {
      if (!shift) throw new Error("Open a shift first");
      if (movementAmount <= 0 || !movementReason.trim()) throw new Error("Enter an amount and reason");
      if (!movementReasonCode) throw new Error("Choose a cash movement reason");
      const chosen = (reasonsQuery.data?.reasons ?? []).find((reason) => reason.reasonCode === movementReasonCode);
      if (chosen && chosen.direction !== "either" && chosen.direction !== movementType) {
        throw new Error("This reason cannot be used for this cash movement direction.");
      }
      const response = await apiRequest("POST", `/api/pos/retail/shifts/${shift.id}/cash-movements`, {
        movementType,
        amount: movementAmount,
        reason: movementReason.trim(),
        reasonCode: movementReasonCode,
        idempotencyKey: makeKey(`retail-${movementType}`),
      });
      return response.json();
    },
    onSuccess: async () => {
      setMovementAmount(0);
      setMovementReason("");
      setMovementReasonCode("");
      await refresh();
      toast({ title: "Cash drawer movement recorded" });
    },
    onError: (error: Error) =>
      toast({ title: "Cash movement failed", description: error.message, variant: "destructive" }),
  });

  const closeMutation = useMutation({
    mutationFn: async () => {
      if (!shift) throw new Error("No open shift");
      const response = await apiRequest("POST", `/api/pos/shifts/${shift.id}/close`, {
        closingCash,
        notes: "Retail POS shift close",
      });
      return response.json();
    },
    onSuccess: async () => {
      await refresh();
      toast({ title: "Cashier shift closed" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not close shift", description: error.message, variant: "destructive" }),
  });

  if (!locationId) return null;

  const summary = summaryQuery.data;
  return (
    <Card data-testid="retail-shift-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="h-4 w-4" /> Cashier shift
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!shift ? (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <div>
              <Label htmlFor="retail-opening-cash">Opening cash</Label>
              <Input
                id="retail-opening-cash"
                type="number"
                min="0"
                step="0.01"
                value={openingCash}
                onChange={(event) => setOpeningCash(Number(event.target.value))}
              />
            </div>
            <div className="flex items-end">
              <Button onClick={() => openMutation.mutate()} disabled={openMutation.isPending}>
                <LogIn className="mr-2 h-4 w-4" /> Open shift
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">Opening</div>
                <strong>{money(Number(shift.openingCash))}</strong>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cash sales</div>
                <strong>{money(summary?.cashSales ?? 0)}</strong>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cash refunds</div>
                <strong>{money(summary?.cashRefunds ?? 0)}</strong>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Expected cash</div>
                <strong>{money(summary?.expectedCash ?? Number(shift.openingCash))}</strong>
              </div>
            </div>

            {summary?.paymentMethods ? (
              <div className="flex flex-wrap gap-1.5 text-xs">
                {Object.entries(summary.paymentMethods).map(([method, amount]) => (
                  <span key={method} className="rounded-full border bg-muted/30 px-2 py-1">
                    {method}: {money(amount)}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="grid gap-2 md:grid-cols-[120px_180px_1fr_auto_auto]">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={movementAmount}
                placeholder="Amount"
                onChange={(event) => setMovementAmount(Number(event.target.value))}
              />
              <select
                aria-label="Cash movement reason"
                className="h-10 rounded-md border bg-background px-2 text-sm"
                value={movementReasonCode}
                onChange={(event) => setMovementReasonCode(event.target.value)}
              >
                <option value="">Reason…</option>
                {(reasonsQuery.data?.reasons ?? []).map((reason) => (
                  <option key={reason.reasonCode} value={reason.reasonCode} disabled={reason.source === "none"}>
                    {reason.label ?? reason.reasonCode}
                    {reason.source === "none" ? " (no account mapped)" : ""}
                  </option>
                ))}
              </select>
              <Input
                value={movementReason}
                placeholder="Cash in/out reason"
                onChange={(event) => setMovementReason(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={movementMutation.isPending}
                onClick={() => movementMutation.mutate("cash_in")}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Cash In
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={movementMutation.isPending}
                onClick={() => movementMutation.mutate("cash_out")}
              >
                <Minus className="mr-1 h-3.5 w-3.5" /> Cash Out
              </Button>
            </div>

            <div className="grid gap-2 border-t pt-3 sm:grid-cols-[1fr_auto]">
              <div>
                <Label htmlFor="retail-closing-cash">Actual closing cash</Label>
                <Input
                  id="retail-closing-cash"
                  type="number"
                  min="0"
                  step="0.01"
                  value={closingCash}
                  onChange={(event) => setClosingCash(Number(event.target.value))}
                />
              </div>
              <div className="flex items-end">
                <Button variant="outline" onClick={() => closeMutation.mutate()} disabled={closeMutation.isPending}>
                  <LogOut className="mr-2 h-4 w-4" /> Close shift
                </Button>
              </div>
            </div>
          </>
        )}

        {(historyQuery.data ?? []).filter((entry) => entry.status === "closed").length > 0 ? (
          <div className="border-t pt-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent shifts
            </div>
            <div className="space-y-1.5">
              {(historyQuery.data ?? [])
                .filter((entry) => entry.status === "closed")
                .slice(0, 5)
                .map((entry) => (
                  <div key={entry.id} className="grid grid-cols-[1fr_auto_auto] gap-2 text-xs">
                    <span>
                      #{entry.id} · {new Date(entry.openedAt).toLocaleDateString()}
                    </span>
                    <span>Expected {money(Number(entry.expectedCash ?? 0))}</span>
                    <span className={Math.abs(Number(entry.variance ?? 0)) > 0.005 ? "text-destructive" : ""}>
                      Var {money(Number(entry.variance ?? 0))}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
