import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableRow, TableHeader } from "@/components/ui/table";

const BASE = "/api/intercompany-container-trading";
interface TradeRow {
  tradeId: number;
  physicalContainerId: number;
  version: number;
  containerNumber: string;
  landedCost: string | null;
  sourceCompanyId: number;
  destinationCompanyId: number;
  destinationPoId: number | null;
}
interface TradeLine {
  lineLinkId: number;
  sourcePoNumber: string;
  quantity: string;
  rate: string;
  lineTotal: string;
  itemName: string;
  sourceLineId: number;
  destinationLineId: number;
}
interface TradeDetail {
  tradeId: number;
  version: number;
  containerNumber: string;
  physicalStatus: string;
  landedCost: string;
  goodsCost: string;
  lines: TradeLine[];
}
interface AllocationPreview {
  faceAmount: string;
  allocations: Array<{ tradeId: number; containerNumber: string; expectedVersion: number; suggestedAmount: string }>;
}
interface InvoiceDetail {
  invoiceId: number;
  externalInvoiceKey: string;
  chargeType: string;
  faceAmount: string;
  evidenceReference: string;
  version: number;
  allocations: Array<{
    tradeId: number;
    containerNumber: string;
    amount: string;
    expectedVersion: number;
    relationshipId: number;
    sourceCompanyId: number;
    destinationCompanyId: number;
  }>;
}
type EditableLine = Pick<TradeLine, "lineLinkId" | "quantity" | "rate" | "itemName">;
const money = (v: string | number | null) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(v || 0));
function today() {
  return new Date().toLocaleDateString("en-CA");
}
function key() {
  return "ic-ui-" + crypto.randomUUID();
}
async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...options });
  const payload = await response.json().catch(() => ({ message: "Request failed" }));
  if (!response.ok) throw new Error(payload.message ?? "Request failed");
  return payload as T;
}
const toCents = (value: string) => Math.round(Number(value || 0) * 100);
export function LinkedTradesEditorContent({
  physicalContainerId,
  embedded = false,
}: { physicalContainerId?: number; embedded?: boolean } = {}) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const companyId = Number(selectedCompany?.id || 0);
  const isProperties = selectedCompany?.companyType === "properties";
  const [selected, setSelected] = useState<number | null>(null);
  const [rows, setRows] = useState<EditableLine[]>([]);
  const [reason, setReason] = useState("Correct confirmed supplier purchase pricing");
  const [postingDate, setPostingDate] = useState(today);
  const [chargeDate, setChargeDate] = useState(today);
  const [invoiceKey, setInvoiceKey] = useState("");
  const [invoiceEvidence, setInvoiceEvidence] = useState("");
  const [chargeType, setChargeType] = useState("freight");
  const [face, setFace] = useState("");
  const [chosen, setChosen] = useState<number[]>([]);
  const [proposal, setProposal] = useState<AllocationPreview | null>(null);
  const [manual, setManual] = useState<Record<number, string>>({});
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lookupId, setLookupId] = useState<number | null>(null);
  const [newAmounts, setNewAmounts] = useState<Record<number, string>>({});
  const [chargeReason, setChargeReason] = useState("Reallocate verified shared freight invoice");
  const [grantee, setGrantee] = useState("");
  const [grantRelation, setGrantRelation] = useState("");
  const [grantScope, setGrantScope] = useState<"invoice" | "relationship">("invoice");
  useEffect(() => {
    setSelected(null);
    setRows([]);
    setChosen([]);
    setProposal(null);
    setLookupId(null);
    setInvoiceNumber("");
    setGrantee("");
  }, [companyId, physicalContainerId]);

  const list = useQuery<{ trades: TradeRow[] }>({
    queryKey: companyQueryKey(BASE + "/linked-trades", companyId),
    enabled: companyId > 0,
    queryFn: () => json(BASE + "/linked-trades"),
    retry: false,
  });
  const activeScopedTrades = physicalContainerId
    ? (list.data?.trades ?? []).filter((row) => row.physicalContainerId === physicalContainerId)
    : (list.data?.trades ?? []);
  useEffect(() => {
    if (!physicalContainerId || !list.data) return;
    const matching = list.data.trades.find((row) => row.physicalContainerId === physicalContainerId);
    setSelected(matching?.tradeId ?? null);
    if (matching) setChosen((previous) => (previous.length ? previous : [matching.tradeId]));
  }, [physicalContainerId, list.data]);
  const validScopedSelection = !physicalContainerId || activeScopedTrades.some((row) => row.tradeId === selected);

  const detail = useQuery<TradeDetail>({
    queryKey: companyQueryKey(BASE + "/linked-trades/" + selected, companyId),
    enabled: companyId > 0 && selected != null && validScopedSelection,
    queryFn: () => json(BASE + "/linked-trades/" + selected),
    retry: false,
  });
  useEffect(() => {
    if (detail.data)
      setRows(
        detail.data.lines.map((line) => ({
          lineLinkId: line.lineLinkId,
          quantity: line.quantity,
          rate: line.rate,
          itemName: line.itemName,
        }))
      );
  }, [detail.data]);
  const invoice = useQuery<InvoiceDetail>({
    queryKey: companyQueryKey(BASE + "/shared-charges/" + lookupId, companyId),
    enabled: companyId > 0 && lookupId != null,
    queryFn: () => json(BASE + "/shared-charges/" + lookupId),
    retry: false,
  });
  useEffect(() => {
    if (invoice.data) setNewAmounts(Object.fromEntries(invoice.data.allocations.map((a) => [a.tradeId, a.amount])));
  }, [invoice.data]);

  const editMutation = useMutation({
    mutationFn: async () => {
      if (!selected || !detail.data || !validScopedSelection) throw new Error("Select a verified linked container");
      const response = await apiRequest("PATCH", BASE + "/linked-trades/" + selected, {
        expectedVersion: detail.data.version,
        requestKey: key(),
        postingDate,
        reason: reason.trim(),
        lines: rows,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Both companies synchronized",
        description: "The price adjustment and accounting vouchers were posted together.",
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/linked-trades", companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/lifecycle", companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/linked-trades/" + selected, companyId) });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
    },
    onError: (e: Error) => toast({ title: "Edit refused", description: e.message, variant: "destructive" }),
  });
  const previewMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", BASE + "/shared-charges/preview", {
        sourceCompanyId: companyId,
        tradeIds: chosen,
        amount: face,
      });
      return response.json() as Promise<AllocationPreview>;
    },
    onSuccess: (data) => {
      setProposal(data);
      setManual(Object.fromEntries(data.allocations.map((a) => [a.tradeId, a.suggestedAmount])));
      toast({
        title: "Proposed allocation ready",
        description: "Review and confirm these amounts; they are not posted yet.",
      });
    },
    onError: (e: Error) => toast({ title: "Allocation not available", description: e.message, variant: "destructive" }),
  });
  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!proposal) throw new Error("Preview the allocations first");
      const allocations = proposal.allocations.map((a) => ({
        tradeId: a.tradeId,
        expectedVersion: a.expectedVersion,
        amount: manual[a.tradeId] || "0",
      }));
      const response = await apiRequest("POST", BASE + "/shared-charges/confirm", {
        sourceCompanyId: companyId,
        invoiceKey: invoiceKey.trim(),
        chargeType,
        faceAmount: face,
        evidenceReference: invoiceEvidence.trim(),
        postingDate: chargeDate,
        reason: "Confirm documented shared invoice " + invoiceKey,
        requestKey: key(),
        allocations,
      });
      return response.json() as Promise<{ invoiceId: number }>;
    },
    onSuccess: (data) => {
      setInvoiceNumber(String(data.invoiceId));
      setLookupId(data.invoiceId);
      setProposal(null);
      toast({ title: "Shared invoice confirmed", description: "Every affected linked PO was updated atomically." });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/linked-trades", companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/lifecycle", companyId) });
    },
    onError: (e: Error) => toast({ title: "Confirmation refused", description: e.message, variant: "destructive" }),
  });
  const reallocateMutation = useMutation({
    mutationFn: async () => {
      if (!invoice.data) throw new Error("Load an invoice to revise");
      const allocations = invoice.data.allocations.map((a) => ({
        tradeId: a.tradeId,
        expectedVersion: a.expectedVersion,
        amount: newAmounts[a.tradeId] ?? a.amount,
      }));
      const response = await apiRequest("PATCH", BASE + "/shared-charges/" + invoice.data.invoiceId, {
        expectedInvoiceVersion: invoice.data.version,
        postingDate: chargeDate,
        requestKey: key(),
        reason: chargeReason.trim(),
        allocations,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Confirmed allocation updated", description: "Original invoice amount was preserved." });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/shared-charges/" + lookupId, companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/linked-trades", companyId) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(BASE + "/lifecycle", companyId) });
    },
    onError: (e: Error) => toast({ title: "Redistribution refused", description: e.message, variant: "destructive" }),
  });
  const grantMutation = useMutation({
    mutationFn: async () => {
      if (!invoice.data) throw new Error("Load an invoice first");
      const response = await apiRequest("POST", BASE + "/shared-charge-grants", {
        userId: grantee.trim(),
        relationshipId: Number(grantRelation),
        scope: grantScope,
        ...(grantScope === "invoice" ? { invoiceKey: invoice.data.externalInvoiceKey } : {}),
      });
      return response.json();
    },
    onSuccess: () => toast({ title: "Shared Charge Editor permission granted" }),
    onError: (e: Error) => toast({ title: "Permission not granted", description: e.message, variant: "destructive" }),
  });
  const trades = list.data?.trades ?? [];
  const editTrades = physicalContainerId ? activeScopedTrades : trades;
  const proposedTotal = proposal ? proposal.allocations.reduce((s, a) => s + toCents(manual[a.tradeId] || "0"), 0) : 0;
  const reallocatedTotal = invoice.data
    ? invoice.data.allocations.reduce((s, a) => s + toCents(newAmounts[a.tradeId] ?? a.amount), 0)
    : 0;

  return (
    <div
      className={embedded ? "space-y-4" : "mx-auto max-w-6xl space-y-6 pb-12"}
      data-testid="intercompany-linked-editor"
    >
      {!embedded && (
        <PageHeader
          title="Linked Container POs & Shared Charges"
          subtitle="Price edits and confirmed costs remain synchronized between Properties and the destination ERP company."
        />
      )}
      <p className="text-sm text-muted-foreground">
        Each edit is a single audited transaction. Original supplier vouchers remain unchanged. Offloaded or sold
        containers are protected until the inventory adjustment workflow is available.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Linked purchase orders</CardTitle>
          <CardDescription>
            Choose a container in this company, then edit quantities, rates or item descriptions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {list.isLoading && <p>Loading linked containers…</p>}
          {list.isError && (
            <p role="alert" className="text-sm text-destructive">
              Linked PO editing is restricted to authorized company Owners, Admins and Developers. Invoice-scoped
              editors can use the invoice section below.
            </p>
          )}
          {embedded && list.isSuccess && editTrades.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No active linked purchase order exists for this physical container.
            </p>
          )}
          {!embedded && (
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {editTrades.map((t) => (
                <Button
                  key={t.tradeId}
                  type="button"
                  variant={selected === t.tradeId ? "default" : "outline"}
                  onClick={() => setSelected(t.tradeId)}
                >
                  {t.containerNumber} · {money(t.landedCost)}
                </Button>
              ))}
            </div>
          )}
          {detail.isError && (
            <p role="alert" className="text-destructive">
              Could not load the linked PO; refresh the company and container selection.
            </p>
          )}
          {validScopedSelection && detail.data && (
            <>
              <div className="rounded-md border p-3 text-sm">
                <strong>{detail.data.containerNumber}</strong> · Revision {detail.data.version} · Confirmed landed cost{" "}
                {money(detail.data.landedCost)} · Status {detail.data.physicalStatus}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Original PO</TableHead>
                      <TableHead>Item description</TableHead>
                      <TableHead>Quantity</TableHead>
                      <TableHead>Rate (USD)</TableHead>
                      <TableHead>Original line total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.data.lines.map((line) => {
                      const edited = rows.find((row) => row.lineLinkId === line.lineLinkId);
                      return (
                        <TableRow key={line.lineLinkId}>
                          <TableCell>{line.sourcePoNumber}</TableCell>
                          <TableCell>
                            <Input
                              aria-label={"Description for " + line.sourcePoNumber + " line " + line.lineLinkId}
                              value={edited?.itemName ?? line.itemName}
                              onChange={(e) =>
                                setRows((old) =>
                                  old.map((row) =>
                                    row.lineLinkId === line.lineLinkId ? { ...row, itemName: e.target.value } : row
                                  )
                                )
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              aria-label={"Quantity for line " + line.lineLinkId}
                              value={edited?.quantity ?? line.quantity}
                              inputMode="decimal"
                              onChange={(e) =>
                                setRows((old) =>
                                  old.map((row) =>
                                    row.lineLinkId === line.lineLinkId ? { ...row, quantity: e.target.value } : row
                                  )
                                )
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              aria-label={"Rate for line " + line.lineLinkId}
                              value={edited?.rate ?? line.rate}
                              inputMode="decimal"
                              onChange={(e) =>
                                setRows((old) =>
                                  old.map((row) =>
                                    row.lineLinkId === line.lineLinkId ? { ...row, rate: e.target.value } : row
                                  )
                                )
                              }
                            />
                          </TableCell>
                          <TableCell>{money(line.lineTotal)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="ic-edit-date">Adjustment posting date</Label>
                  <Input
                    id="ic-edit-date"
                    type="date"
                    value={postingDate}
                    onChange={(e) => setPostingDate(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="ic-edit-reason">Reason / source evidence</Label>
                  <Input id="ic-edit-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              </div>
              <Button
                disabled={editMutation.isPending || detail.data.physicalStatus !== "OTW"}
                onClick={() => editMutation.mutate()}
              >
                {editMutation.isPending ? "Validating both companies…" : "Synchronize this linked purchase order"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {isProperties && (
        <Card>
          <CardHeader>
            <CardTitle>Confirm a shared freight or handling invoice</CardTitle>
            <CardDescription>
              Preview a purchase-value-weighted allocation. Override amounts before confirming the immutable external
              invoice face value.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
              <div>
                <Label htmlFor="ic-invoice-key">Original invoice reference</Label>
                <Input id="ic-invoice-key" value={invoiceKey} onChange={(e) => setInvoiceKey(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ic-invoice-face">Invoice total (USD)</Label>
                <Input
                  id="ic-invoice-face"
                  value={face}
                  onChange={(e) => {
                    setFace(e.target.value);
                    setProposal(null);
                  }}
                  inputMode="decimal"
                />
              </div>
              <div>
                <Label htmlFor="ic-invoice-type">Charge type</Label>
                <select
                  id="ic-invoice-type"
                  value={chargeType}
                  onChange={(e) => setChargeType(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="freight">Freight</option>
                  <option value="surcharge">Surcharge</option>
                  <option value="fumigation">Fumigation</option>
                  <option value="documentCharges">Documents</option>
                  <option value="otherCharges">Handling / other</option>
                </select>
              </div>
              <div>
                <Label htmlFor="ic-invoice-date">Posting date</Label>
                <Input
                  id="ic-invoice-date"
                  type="date"
                  value={chargeDate}
                  onChange={(e) => setChargeDate(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="ic-evidence">Verified invoice document / evidence</Label>
              <Input id="ic-evidence" value={invoiceEvidence} onChange={(e) => setInvoiceEvidence(e.target.value)} />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {trades.map((t) => (
                <label key={t.tradeId} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                  <Checkbox
                    checked={chosen.includes(t.tradeId)}
                    onCheckedChange={(v) => {
                      setChosen((old) =>
                        v === true
                          ? [...old.filter((id) => id !== t.tradeId), t.tradeId]
                          : old.filter((id) => id !== t.tradeId)
                      );
                      setProposal(null);
                    }}
                  />
                  {t.containerNumber}
                </label>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!chosen.length || !face || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              Preview proportional allocation
            </Button>
            {proposal && (
              <div className="space-y-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Container</TableHead>
                      <TableHead>Confirmed allocation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {proposal.allocations.map((a) => (
                      <TableRow key={a.tradeId}>
                        <TableCell>{a.containerNumber}</TableCell>
                        <TableCell>
                          <Input
                            aria-label={"Shared amount for " + a.containerNumber}
                            value={manual[a.tradeId] ?? a.suggestedAmount}
                            inputMode="decimal"
                            onChange={(e) => setManual((old) => ({ ...old, [a.tradeId]: e.target.value }))}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-sm">
                  Allocated {money(proposedTotal / 100)} of {money(face)}.
                  {proposedTotal !== toCents(face) ? " The invoice must balance before confirmation." : ""}
                </p>
                <Button
                  disabled={
                    confirmMutation.isPending || proposedTotal !== toCents(face) || !invoiceKey || !invoiceEvidence
                  }
                  onClick={() => confirmMutation.mutate()}
                >
                  Confirm and post shared invoice
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Review or redistribute a confirmed invoice</CardTitle>
          <CardDescription>
            Confirmed allocations do not automatically change when a container's purchase price changes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="ic-find-invoice">Shared invoice ID</Label>
              <Input
                id="ic-find-invoice"
                value={invoiceNumber}
                inputMode="numeric"
                onChange={(e) => setInvoiceNumber(e.target.value)}
                placeholder="Invoice ID"
              />
            </div>
            <Button variant="outline" onClick={() => setLookupId(Number(invoiceNumber) || null)}>
              Load verified invoice
            </Button>
          </div>
          {invoice.isError && (
            <p role="alert" className="text-destructive">
              Invoice not found or you do not have Shared Charge Editor access.
            </p>
          )}
          {invoice.data && (
            <>
              <p className="text-sm">
                <strong>{invoice.data.externalInvoiceKey}</strong> · Version {invoice.data.version} · Original face
                amount {money(invoice.data.faceAmount)}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Container</TableHead>
                    <TableHead>Destination company</TableHead>
                    <TableHead>Revised allocation (USD)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.data.allocations.map((a) => (
                    <TableRow key={a.tradeId}>
                      <TableCell>{a.containerNumber}</TableCell>
                      <TableCell>{a.destinationCompanyId}</TableCell>
                      <TableCell>
                        <Input
                          aria-label={"Reallocate " + a.containerNumber}
                          inputMode="decimal"
                          value={newAmounts[a.tradeId] ?? a.amount}
                          onChange={(e) => setNewAmounts((old) => ({ ...old, [a.tradeId]: e.target.value }))}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-sm">
                Reallocated {money(reallocatedTotal / 100)} of {money(invoice.data.faceAmount)}.
              </p>
              <div>
                <Label htmlFor="ic-allocation-reason">Reason for redistribution</Label>
                <Input
                  id="ic-allocation-reason"
                  value={chargeReason}
                  onChange={(e) => setChargeReason(e.target.value)}
                />
              </div>
              <Button
                disabled={reallocateMutation.isPending || reallocatedTotal !== toCents(invoice.data.faceAmount)}
                onClick={() => reallocateMutation.mutate()}
              >
                Apply verified allocation changes
              </Button>
              <div className="border-t pt-4 space-y-2">
                <h3 className="font-medium">Grant Shared Charge Editor access</h3>
                <p className="text-xs text-muted-foreground">
                  Only an Owner or Developer can grant access to users in the granting company. Default Admin access
                  does not include this permission.
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="ic-grantee">User ID</Label>
                    <Input id="ic-grantee" value={grantee} onChange={(e) => setGrantee(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="ic-grant-relation">Involved company relationship</Label>
                    <select
                      id="ic-grant-relation"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={grantRelation}
                      onChange={(e) => setGrantRelation(e.target.value)}
                    >
                      <option value="">Choose relationship</option>
                      {[...new Set(invoice.data.allocations.map((a) => a.relationshipId))].map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="ic-grant-scope">Permission scope</Label>
                    <select
                      id="ic-grant-scope"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={grantScope}
                      onChange={(e) => setGrantScope(e.target.value as "invoice" | "relationship")}
                    >
                      <option value="invoice">This invoice only</option>
                      <option value="relationship">All invoices on this company pair</option>
                    </select>
                  </div>
                </div>
                <Button
                  variant="outline"
                  disabled={!grantee.trim() || !grantRelation || grantMutation.isPending}
                  onClick={() => grantMutation.mutate()}
                >
                  Grant editor permission
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Route-level wrapper stays compatible with wouter RouteComponentProps. */
export default function LinkedTradesEditor() {
  return <LinkedTradesEditorContent />;
}
