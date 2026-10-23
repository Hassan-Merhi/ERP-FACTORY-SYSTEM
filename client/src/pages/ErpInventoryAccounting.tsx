/**
 * Phase 6 ERP inventory and COGS ledger bridge.
 * Read-only: a discrepancy is not a mandate to generate correction vouchers.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Kind = "sale" | "purchase_order" | "offload" | "inventory_movement" | "credit_debit_note" | "transfer";
type Status = "posted" | "cost_mismatch" | "date_mismatch" | "missing" | "expected_periodic" | "review";
interface Row {
  kind: Kind;
  sourceId: string;
  documentNumber: string;
  documentDate: string;
  linkedJournalNumber: string;
  linkedJournalId: number | null;
  linkedJournalDate: string | null;
  expectedStockMovement: string | null;
  postedStockMovement: string | null;
  status: Status;
  note: string;
}
interface Audit {
  companyId: number;
  asOfDate: string;
  postingReady: boolean;
  cutover: { effectiveFrom: string; openingVoucherId: number | null } | null;
  accountingMode: "PERIODIC" | "PERPETUAL" | "SUPPLIER_PARTNER";
  valuation: {
    subLedgerAtCost: string | null;
    ledgerInventory: string | null;
    difference: string | null;
    basis: string;
    historicalReliable: boolean;
  };
  summary: {
    sources: number;
    posted: number;
    missing: number;
    mismatched: number;
    periodic: number;
    review: number;
    truncated: boolean;
  };
  journals: Row[];
  policy: {
    sourceOfCost: string;
    cutoverActivation: string;
    historicalAdjustment: string;
    transfers: string;
    returns: string;
    landedCosts: string;
  };
}
interface Readiness {
  ready: boolean;
  postingReady: boolean;
  blockers: Array<{ code: string; count: number; message: string }>;
  effectiveFrom: string;
  cutover: { effectiveFrom: string } | null;
  openingPlan: { lines: number; total: string; unvalued: number } | null;
  reconciliation: { reconciled: boolean; differences: number } | null;
}
async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.message || "Unable to retrieve the inventory audit");
  return v as T;
}
function sourceLabel(k: Kind) {
  return (
    {
      sale: "Sales / COGS",
      purchase_order: "Purchase / GIT",
      offload: "Offload / stock-in",
      inventory_movement: "Inventory adjustment",
      credit_debit_note: "Credit / debit note",
      transfer: "Stock transfer",
    } as const
  )[k];
}
export default function ErpInventoryAccounting() {
  const [asOf, setAsOf] = useState("");
  const [kind, setKind] = useState<Kind | "all">("all");
  const [status, setStatus] = useState<Status | "all">("all");
  const audit = useQuery<Audit>({
    queryKey: ["/api/accounting/erp-inventory/audit", asOf],
    queryFn: () => get("/api/accounting/erp-inventory/audit" + (asOf ? "?asOfDate=" + asOf : "")),
    retry: false,
  });
  const readiness = useQuery<Readiness>({
    queryKey: ["/api/accounting/erp-inventory/readiness"],
    queryFn: () => get("/api/accounting/erp-inventory/readiness"),
    retry: false,
  });
  const current = audit.data;
  const rows = useMemo(
    () =>
      current?.journals.filter(
        (r) => (kind === "all" || r.kind === kind) && (status === "all" || r.status === status)
      ) ?? [],
    [current, kind, status]
  );
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="erp-inventory-accounting">
      <div>
        <h1 className="text-2xl font-semibold">ERP Inventory & COGS Accounting</h1>
        <p className="text-sm text-muted-foreground">
          Trace purchases, offloads, sales and stock adjustments to their financial journals. Read-only until the
          existing perpetual inventory cutover is certified.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Accounting policy & cutover</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {current && (
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <p className="text-muted-foreground">Bookkeeping mode</p>
                <p className="font-semibold">{current.accountingMode}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Cutover effective from</p>
                <p className="font-semibold">{current.cutover?.effectiveFrom ?? "Not applied"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Posting gate</p>
                <p className="font-semibold">{current.postingReady ? "Available" : "Disabled — no activation"}</p>
              </div>
            </div>
          )}
          {!current?.postingReady && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              The existing perpetual inventory activation gate remains disabled. Missing COGS and Goods in Transit
              journals before cutover are expected, not a reason to create historical vouchers.
            </p>
          )}
          <p>
            Inventory is valued at recorded cost, not selling price. Inter-location stock transfers do not create
            consolidated income or COGS.
          </p>
          {readiness.isError && <p className="text-destructive">{(readiness.error as Error).message}</p>}
          {readiness.data && (
            <>
              <p>
                <strong>Existing cutover readiness:</strong>{" "}
                {readiness.data.ready ? "Ready for further certification" : "Not ready"}
                {" · "}Target date {readiness.data.effectiveFrom}
              </p>
              {(readiness.data.blockers ?? []).length > 0 && (
                <div className="space-y-1">
                  {readiness.data.blockers.map((b) => (
                    <p key={b.code} className="text-sm">
                      <span className="font-semibold">{b.code}</span> ({b.count}): {b.message}
                    </p>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Readiness is diagnostic only. This screen cannot activate perpetual inventory or post opening inventory.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Inventory at cost vs. ledger</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="inventory-accounting-date">As-of date</Label>
              <Input
                id="inventory-accounting-date"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              disabled={audit.isFetching}
              onClick={() => {
                audit.refetch();
                readiness.refetch();
              }}
            >
              Refresh audit
            </Button>
          </div>
          {audit.isError && (
            <p className="text-sm text-destructive" role="alert">
              {(audit.error as Error).message}
            </p>
          )}
          {current && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {(
                  [
                    ["ERP stock at recorded cost", current.valuation.subLedgerAtCost],
                    ["Inventory ledger (perpetual only)", current.valuation.ledgerInventory],
                    ["GL - inventory difference", current.valuation.difference],
                  ] as Array<[string, string | null]>
                ).map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="font-semibold tabular-nums">{value ?? "Not applicable"}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{current.valuation.basis}</p>
              {!current.valuation.historicalReliable && (
                <p className="text-xs text-muted-foreground">
                  Historical stock values rely on the existing inventory movement replay. This report does not certify
                  missing legacy records.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
      {current && (
        <Card>
          <CardHeader>
            <CardTitle>Source-linked accounting journals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
              {Object.entries(current.summary)
                .filter(([key]) => key !== "truncated")
                .map(([key, value]) => (
                  <div key={key}>
                    <p className="text-xs text-muted-foreground">{key}</p>
                    <p className="text-lg font-semibold tabular-nums">{String(value)}</p>
                  </div>
                ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label>Document kind</Label>
                <select
                  className="block h-9 rounded-md border bg-background px-2 text-sm"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as Kind | "all")}
                >
                  <option value="all">All kinds</option>
                  {(
                    [
                      "sale",
                      "purchase_order",
                      "offload",
                      "inventory_movement",
                      "credit_debit_note",
                      "transfer",
                    ] as Kind[]
                  ).map((k) => (
                    <option key={k} value={k}>
                      {sourceLabel(k)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Status</Label>
                <select
                  className="block h-9 rounded-md border bg-background px-2 text-sm"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Status | "all")}
                >
                  <option value="all">All statuses</option>
                  {(
                    ["posted", "review", "missing", "cost_mismatch", "date_mismatch", "expected_periodic"] as Status[]
                  ).map((k) => (
                    <option key={k} value={k}>
                      {k.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {current.summary.truncated && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                The source audit is limited to the latest 250 documents per source kind, including credit/debit notes
                and transfers. Older documents are not certified by this preview.
              </p>
            )}
            <div className="max-h-[650px] overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Source</th>
                    <th className="p-2">Date</th>
                    <th className="p-2">Linked journal</th>
                    <th className="p-2 text-right">Recorded cost delta</th>
                    <th className="p-2 text-right">Posted stock delta</th>
                    <th className="p-2">Audit status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={row.kind + row.sourceId + "-" + i} className="border-b align-top">
                      <td className="p-2">
                        {sourceLabel(row.kind)}
                        <div className="text-xs text-muted-foreground">{row.documentNumber}</div>
                      </td>
                      <td className="p-2">{row.documentDate}</td>
                      <td className="p-2">
                        {row.linkedJournalId !== null ? (
                          <a className="underline" href={`/voucher-detail/${row.linkedJournalId}`}>
                            {row.linkedJournalNumber}
                          </a>
                        ) : (
                          row.linkedJournalNumber
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {row.expectedStockMovement ?? "Not reconstructable"}
                      </td>
                      <td className="p-2 text-right tabular-nums">{row.postedStockMovement ?? "—"}</td>
                      <td className="p-2">
                        {row.status.replaceAll("_", " ")}
                        <p className="text-xs text-muted-foreground">{row.note}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && (
                <p className="p-3 text-sm text-muted-foreground">No source documents match this filter.</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              No actions on this page alter historical vouchers, stock quantities, landed costs, returns, or COGS.
              Resolve any discrepancies through existing controlled accounting and inventory workflows after review.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
