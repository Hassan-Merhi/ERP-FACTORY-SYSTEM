import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const API = "/api/intercompany-container-trading/lifecycle";
const newKey = () =>
  "ic-phase5-" +
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));
const dateNow = () => new Date().toLocaleDateString("en-CA");
const money = (value: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value));
type Trade = {
  tradeId: number;
  physicalContainerId: number;
  relationshipId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  version: number;
  state: string;
  containerNumber: string;
  physicalStatus: string;
  landedCost: string;
  received: null | { id: number; date: string; locationId: number; voucherId: number };
  canceled: null | { id: number; date: string; releasedCredit: string };
  hasSharedInvoices: boolean;
  pendingSharedAllocation: boolean;
};
type Lifecycle = {
  trades: Trade[];
  locations: Array<{ id: number; name: string }>;
  inventoryAccounts: Array<{ id: number; name: string }>;
};
async function load(companyId: number): Promise<Lifecycle> {
  if (!companyId) throw new Error("Select a company");
  const response = await fetch(API, { credentials: "include" });
  const value = await response.json().catch(() => ({ message: "Cannot read intercompany lifecycle" }));
  if (!response.ok) throw new Error(value.message || "Cannot read intercompany lifecycle");
  return value as Lifecycle;
}

export function IntercompanyLifecycleContent({
  physicalContainerId,
  embedded = false,
}: { physicalContainerId?: number; embedded?: boolean } = {}) {
  const { selectedCompany } = useCompany();
  const companyId = Number(selectedCompany?.id || 0);
  const { toast } = useToast();
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(null);
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState(dateNow);
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [arrivalVerified, setArrivalVerified] = useState(false);
  const [costVerified, setCostVerified] = useState(false);
  const [goodsNotReceived, setGoodsNotReceived] = useState(false);
  const [cashUnchanged, setCashUnchanged] = useState(false);
  const [redistributed, setRedistributed] = useState(false);
  const [receiptKey, setReceiptKey] = useState(newKey);
  const [cancelKey, setCancelKey] = useState(newKey);

  const query = useQuery({
    queryKey: companyQueryKey(API, companyId),
    enabled: companyId > 0,
    queryFn: () => load(companyId),
    retry: false,
  });
  const visibleTrades = physicalContainerId
    ? (query.data?.trades ?? []).filter((row) => row.physicalContainerId === physicalContainerId)
    : (query.data?.trades ?? []);
  const trade = visibleTrades.find((row) => row.tradeId === selectedTradeId);
  const receivingOptions = useQuery<{
    destinationCompanyId: number;
    locations: Array<{ id: number; name: string }>;
    inventoryAccountId: number | null;
    inventoryAccountStatus: "ready" | "ambiguous" | "missing";
  }>({
    queryKey: companyQueryKey(API + "/" + trade?.tradeId + "/receiving-options", companyId),
    enabled: Boolean(
      trade &&
      trade.state === "active" &&
      !trade.received &&
      !trade.canceled &&
      (selectedCompany?.companyType !== "properties" || ["Owner", "Developer"].includes(selectedCompany?.role ?? ""))
    ),
    queryFn: async () => {
      const response = await fetch(API + "/" + trade!.tradeId + "/receiving-options", { credentials: "include" });
      const value = await response.json().catch(() => ({ message: "Cannot load receiving options" }));
      if (!response.ok) throw new Error(value.message || "Cannot load receiving options");
      return value;
    },
    retry: false,
  });
  useEffect(() => {
    setSelectedTradeId(null);
    setLocationId("");
    setEvidence("");
    setReason("");
    setArrivalVerified(false);
    setCostVerified(false);
    setGoodsNotReceived(false);
    setCashUnchanged(false);
    setRedistributed(false);
    setReceiptKey(newKey());
    setCancelKey(newKey());
  }, [companyId, physicalContainerId]);
  useEffect(() => {
    if (!physicalContainerId || !query.data) return;
    const matching = query.data.trades.find((row) => row.physicalContainerId === physicalContainerId);
    setSelectedTradeId(matching?.tradeId ?? null);
  }, [physicalContainerId, query.data]);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: companyQueryKey(API, companyId) });
    queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
    if (physicalContainerId) queryClient.invalidateQueries({ queryKey: [`/api/containers/${physicalContainerId}`] });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey("/api/intercompany-container-trading/linked-trades", companyId),
    });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey("/api/intercompany-container-trading/payments/relationships", companyId),
    });
  };
  const receive = useMutation({
    mutationFn: async () => {
      if (!trade) throw new Error("Select a linked container");
      const response = await apiRequest("POST", API + "/" + trade.tradeId + "/receive", {
        expectedVersion: trade.version,
        requestKey: receiptKey,
        postingDate: date,
        locationId: Number(locationId),
        inventoryAccountId: Number(receivingOptions.data?.inventoryAccountId),
        arrivalEvidence: evidence.trim(),
        reason: reason.trim(),
        confirmPhysicalArrival: arrivalVerified,
        confirmNoAdditionalUnpostedCharges: costVerified,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Destination ERP inventory received",
        description: "One GIT-to-INVENTORY voucher and canonical stock evidence were posted together.",
      });
      setReceiptKey(newKey());
      setSelectedTradeId(null);
      setEvidence("");
      setArrivalVerified(false);
      setCostVerified(false);
      refresh();
    },
    onError: (error: Error) =>
      toast({ title: "Receipt not posted", description: error.message, variant: "destructive" }),
  });
  const cancel = useMutation({
    mutationFn: async () => {
      if (!trade) throw new Error("Select a linked container");
      const response = await apiRequest("POST", API + "/" + trade.tradeId + "/cancel", {
        expectedVersion: trade.version,
        requestKey: cancelKey,
        postingDate: date,
        cancellationEvidence: evidence.trim(),
        reason: reason.trim(),
        sharedChargeDecision: trade.hasSharedInvoices ? "redistributed" : "none",
        confirmGoodsNotReceived: goodsNotReceived,
        confirmNoRealCashReversal: cashUnchanged,
      });
      return response.json() as Promise<{ releasedCredit: string }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Unreceived internal trade canceled",
        description:
          "Original purchases and cash retained; " + money(result.releasedCredit) + " returned to same-pair credit.",
      });
      setCancelKey(newKey());
      setSelectedTradeId(null);
      setEvidence("");
      setGoodsNotReceived(false);
      setCashUnchanged(false);
      setRedistributed(false);
      refresh();
    },
    onError: (error: Error) =>
      toast({ title: "Cancellation refused", description: error.message, variant: "destructive" }),
  });
  const canReceive = Boolean(
    trade &&
    trade.state === "active" &&
    !trade.received &&
    !trade.canceled &&
    Boolean(receivingOptions.data?.inventoryAccountId) &&
    Boolean(receivingOptions.data?.locations.some((loc) => String(loc.id) === locationId)) &&
    locationId &&
    date &&
    evidence.trim().length >= 8 &&
    reason.trim().length >= 3 &&
    arrivalVerified &&
    costVerified &&
    !receive.isPending
  );
  const canCancel = Boolean(
    trade &&
    trade.state === "active" &&
    !trade.received &&
    !trade.canceled &&
    ["Owner", "Developer"].includes(selectedCompany?.role ?? "") &&
    !trade.pendingSharedAllocation &&
    (!trade.hasSharedInvoices || redistributed) &&
    evidence.trim().length >= 8 &&
    reason.trim().length >= 3 &&
    goodsNotReceived &&
    cashUnchanged &&
    date &&
    !cancel.isPending
  );

  return (
    <div
      className={embedded ? "space-y-4" : "mx-auto max-w-6xl space-y-6 pb-10"}
      data-testid="intercompany-phase5-lifecycle"
    >
      {!embedded && (
        <PageHeader
          title="Intercompany Receiving & Cancellation"
          subtitle="Receive into the actual destination ERP, or reverse an unreceived internal sale. The original physical container and cash transfers are never duplicated."
        />
      )}
      {!embedded && (
        <Card>
          <CardHeader>
            <CardTitle>Linked container lifecycle</CardTitle>
            <CardDescription>
              No action here changes or removes a physical Properties container. Received stock cannot be canceled
              without a separate audited inventory and COGS correction.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {query.isError && (
              <p role="alert" className="text-destructive">
                Cannot access the verified linked trade records.
              </p>
            )}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Container</TableHead>
                    <TableHead>ERP destination</TableHead>
                    <TableHead>Confirmed cost</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleTrades.map((row) => (
                    <TableRow key={row.tradeId}>
                      <TableCell>{row.containerNumber}</TableCell>
                      <TableCell>Company #{row.destinationCompanyId}</TableCell>
                      <TableCell>{money(row.landedCost)}</TableCell>
                      <TableCell>
                        {row.canceled
                          ? "Canceled " + row.canceled.date
                          : row.received
                            ? "Received " + row.received.date
                            : row.state === "active"
                              ? "In transit"
                              : row.state}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedTradeId(row.tradeId);
                            setLocationId("");
                            setEvidence("");
                            setReason("");
                            setArrivalVerified(false);
                            setCostVerified(false);
                            setGoodsNotReceived(false);
                            setCashUnchanged(false);
                            setRedistributed(false);
                            setReceiptKey(newKey());
                            setCancelKey(newKey());
                          }}
                        >
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      {embedded && query.isLoading && <p className="text-sm text-muted-foreground">Loading linked container status…</p>}
      {embedded && query.isError && (
        <p role="alert" className="text-sm text-destructive">
          Cannot load the linked container lifecycle.
        </p>
      )}
      {embedded && !query.isLoading && !query.isError && visibleTrades.length === 0 && (
        <p className="text-sm text-muted-foreground">
          This physical container has no linked intercompany trade. Import its PO with an ERP destination first.
        </p>
      )}
      {trade && (
        <Card>
          <CardHeader>
            <CardTitle>{trade.containerNumber} — verified company pair</CardTitle>
            <CardDescription>
              Properties #{trade.sourceCompanyId} / ERP #{trade.destinationCompanyId}. Confirmed landed cost{" "}
              {money(trade.landedCost)}. Trade version {trade.version}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {trade.canceled && (
              <p>Trade canceled. Original supplier invoices and real cash transactions remain auditable.</p>
            )}
            {trade.received && (
              <p>
                Stock received in ERP location #{trade.received.locationId}, voucher #{trade.received.voucherId}.
                Further receipt and cancellation are disabled.
              </p>
            )}
            {trade.state === "active" && !trade.received && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="ic-phase5-date">Actual posting date</Label>
                    <Input id="ic-phase5-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="ic-phase5-reason">Documented accounting reason</Label>
                    <Input id="ic-phase5-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="ic-phase5-evidence">Arrival or cancellation supporting evidence</Label>
                    <Input id="ic-phase5-evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
                  </div>
                </div>
                {(companyId === trade.destinationCompanyId ||
                  (selectedCompany?.companyType === "properties" &&
                    ["Owner", "Developer"].includes(selectedCompany?.role ?? ""))) && (
                  <div className="space-y-3 rounded-lg border p-4">
                    <h3 className="font-semibold">Receive into this ERP company</h3>
                    <p className="text-sm text-muted-foreground">
                      Reclassifies only the verified linked cost from Goods in Transit into the ERP INVENTORY account.
                      Existing negative-stock or residual-value situations are refused.
                    </p>
                    <Label htmlFor="ic-phase5-location">
                      Actual receiving warehouse in ERP #{trade.destinationCompanyId}
                    </Label>
                    <select
                      id="ic-phase5-location"
                      value={locationId}
                      onChange={(e) => setLocationId(e.target.value)}
                      className="w-full rounded-md border bg-background p-2"
                    >
                      <option value="">Choose ERP location</option>
                      {receivingOptions.data?.locations.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground" data-testid="intercompany-inventory-account-status">
                      {receivingOptions.isLoading
                        ? "Verifying the ERP warehouse and INVENTORY account…"
                        : receivingOptions.data?.inventoryAccountStatus === "ready"
                          ? "Verified ERP INVENTORY account automatically selected."
                          : "No unique active ERP INVENTORY asset account exists. Resolve the account in the destination ERP before receiving."}
                    </p>
                    {receivingOptions.isError && (
                      <p role="alert" className="text-sm text-destructive">
                        {receivingOptions.error?.message}
                      </p>
                    )}
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={arrivalVerified} onCheckedChange={(v) => setArrivalVerified(v === true)} />I
                      verified the physical goods arrived at this ERP warehouse
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={costVerified} onCheckedChange={(v) => setCostVerified(v === true)} />I verified
                      this confirmed landed cost includes all approved charges
                    </label>
                    <Button disabled={!canReceive} onClick={() => receive.mutate()}>
                      {receive.isPending ? "Validating stock and GIT…" : "Receive stock and post GIT reclassification"}
                    </Button>
                  </div>
                )}
                <div className="space-y-3 rounded-lg border p-4">
                  <h3 className="font-semibold">Cancel before goods are received</h3>
                  <p className="text-sm text-muted-foreground">
                    Requires Owner/Developer permission. Cancels the internal sale and GIT/payable with balancing
                    vouchers; keeps the external supplier purchase, bank movements and original-pair credit history.
                  </p>
                  {trade.pendingSharedAllocation && (
                    <p role="alert" className="text-destructive">
                      A confirmed shared invoice still allocates cost to this container. A dedicated Shared Charge
                      Editor must first redistribute that amount to other active linked containers while preserving the
                      invoice total.
                    </p>
                  )}
                  {trade.hasSharedInvoices && !trade.pendingSharedAllocation && (
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={redistributed} onCheckedChange={(v) => setRedistributed(v === true)} />I
                      reviewed the authorized shared-invoice redistribution and unchanged external face total
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={goodsNotReceived} onCheckedChange={(v) => setGoodsNotReceived(v === true)} />I
                    confirm neither destination inventory nor downstream sales/transfers have received these goods
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={cashUnchanged} onCheckedChange={(v) => setCashUnchanged(v === true)} />I
                    understand this does not refund or reverse any real cash or bank payment
                  </label>
                  <Button variant="destructive" disabled={!canCancel} onClick={() => cancel.mutate()}>
                    {cancel.isPending ? "Checking both ledgers…" : "Cancel internal trade with paired accounting"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Route-level wrapper stays compatible with wouter RouteComponentProps. */
export default function IntercompanyLifecycle() {
  return <IntercompanyLifecycleContent />;
}
