// Extracted from ./SpOffloadDialog.tsx
import { Badge } from "@/components/ui/badge";
import { FileText, TrendingDown, TrendingUp, Building2 } from "lucide-react";
import { fmt2 } from "./SpOffloadDialog";
import type { SpOffloadDialogProps } from "./SpOffloadDialog";
import type { SpOffloadDialogModel, SpOffloadDialogView } from "./SpOffloadDialogModel";

export function SpOffloadDialogPostingPreview({
  sp,
  costs,
  container,
}: {
  sp: SpOffloadDialogModel;
  costs: SpOffloadDialogView;
  container: NonNullable<SpOffloadDialogProps["container"]>;
}) {
  return (
    <>
      {sp.freshStartOtw ? (
        <div
          className="rounded-md border border-border bg-muted/20 p-3 space-y-2"
          data-testid="fresh-start-phase8-offload-preview"
        >
          <p className="text-sm font-medium">Golden Coast Phase 8 — Accounting Preview</p>
          <p className="text-xs text-muted-foreground">
            One balanced journal transfers the existing Goods OTW amount into stock. Invoice freight and discount are
            already included; no supplier or clearing charge is created again.
          </p>
          <div className="flex justify-between text-sm">
            <span>Dr Stock on Floor</span>
            <strong>{fmt2(costs.totalFinalCost)}</strong>
          </div>
          <div className="flex justify-between text-sm">
            <span>Cr Goods OTW</span>
            <strong>{fmt2(costs.invoiceTotal)}</strong>
          </div>
          {costs.activeCharges.length > 0 && (
            <div className="flex justify-between text-sm">
              <span>Cr selected bank — additional charges only</span>
              <strong>{fmt2(costs.activeCharges.reduce((sum, charge) => sum + Number(charge.amountUsd), 0))}</strong>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Accounting Preview</p>
              <p className="text-xs text-muted-foreground">
                {costs.agentCharges.length > 0
                  ? "Three journal vouchers will be created: two in SP Test Co, one in HADI L'SHI"
                  : "Two journal vouchers will be created on confirm"}
              </p>
            </div>
          </div>

          {/* Voucher A: OTW Reversal */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Voucher A — Goods OTW Reversal (SP Test Co)
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1">
              <div className="grid grid-cols-3 text-xs text-muted-foreground font-medium pb-1 border-b border-border/40">
                <span className="col-span-2">Account</span>
                <span className="text-right">Dr / Cr</span>
              </div>
              <div className="grid grid-cols-3 text-xs py-0.5">
                <span className="col-span-2 font-medium">
                  {costs.otwClrAcct?.name ?? "Goods OTW Clearing"}{" "}
                  <Badge variant="secondary" className="text-xs ml-1">
                    Dr
                  </Badge>
                </span>
                <span className="text-right tabular-nums font-semibold">{fmt2(costs.invoiceTotal)}</span>
              </div>
              <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                <span className="col-span-2 pl-4">{costs.otwAcct?.name ?? "Goods OTW"} (Cr)</span>
                <span className="text-right tabular-nums">{fmt2(costs.invoiceTotal)}</span>
              </div>
            </div>
          </div>

          {/* Voucher B: Stock Creation */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Voucher B — Stock Creation (SP Test Co)
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1">
              <div className="grid grid-cols-3 text-xs text-muted-foreground font-medium pb-1 border-b border-border/40">
                <span className="col-span-2">Account</span>
                <span className="text-right">Dr / Cr</span>
              </div>
              <div className="grid grid-cols-3 text-xs py-0.5">
                <span className="col-span-2 font-medium">
                  {costs.stockAcct?.name ?? "SP Stock on Floor"}{" "}
                  <Badge variant="secondary" className="text-xs ml-1">
                    Dr
                  </Badge>
                </span>
                <span className="text-right tabular-nums font-semibold">{fmt2(costs.totalFinalCost)}</span>
              </div>
              <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                <span className="col-span-2 pl-4">
                  {costs.costClrAcct?.name ?? "SP Cost Clearing"} — base supplier cost (Cr)
                </span>
                <span className="text-right tabular-nums">{fmt2(costs.totalBaseCost)}</span>
              </div>
              {costs.invoiceCharges.map((c) => (
                <div key={c.kind} className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                  <span className="col-span-2 pl-4">
                    {costs.costClrAcct?.name ?? "Cost Clearing"} (Cr) — {c.description}
                  </span>
                  <span className="text-right tabular-nums">{fmt2(c.amountUsd)}</span>
                </div>
              ))}
              {costs.activeCharges.map((c, idx) => {
                const amt = parseFloat(c.amountUsd || "0");
                let creditLabel: string;
                if (c.chargeType === "prepaid_used") {
                  const p = (container.prepaid || []).find((x) => String(x.id) === c.prepaidChargeId);
                  creditLabel = costs.prepaidAcct?.name ?? "SP Prepaid Charges";
                  if (p) creditLabel += ` — ${p.chargeType}`;
                } else if (c.chargeType === "paid_now") {
                  const b = (sp.statusData?.bankAccounts || []).find((x) => String(x.id) === c.creditBankAccountId);
                  creditLabel = b ? b.bankName : "Bank Account";
                } else if (c.chargeType === "unpaid_payable" || c.chargeType === "other") {
                  const a = sp.ledgerAccounts.find((x) => String(x.id) === c.creditLedgerAccountId);
                  creditLabel = a ? `${a.name}` : "Ledger Account";
                } else if (c.chargeType === "parent_agent") {
                  creditLabel = costs.prepaidExpAcct?.name ?? "Prepaid Expenses";
                  const agent = sp.parentAgents.find((x) => String(x.ledger_account_id) === c.parentAgentAccountId);
                  if (agent) creditLabel += ` (via ${agent.account_name})`;
                } else {
                  creditLabel = `${costs.costClrAcct?.name ?? "Cost Clearing"} — freight`;
                }
                return (
                  <div key={idx} className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                    <span className="col-span-2 pl-4">
                      {creditLabel} (Cr){c.description ? ` — ${c.description}` : ""}
                    </span>
                    <span className="text-right tabular-nums">{fmt2(amt)}</span>
                  </div>
                );
              })}
              {costs.activeCharges.length === 0 && costs.invoiceCharges.length === 0 && (
                <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
                  <span className="col-span-2 pl-4">No landed charges — Cr equals base cost only</span>
                  <span className="text-right tabular-nums">—</span>
                </div>
              )}
            </div>
          </div>

          {/* Voucher C: HADI L'SHI Agent Journal — only if agent charges exist */}
          {costs.agentCharges.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Voucher C — Agent Charges (HADI L'SHI)
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1">
                <div className="grid grid-cols-3 text-xs text-muted-foreground font-medium pb-1 border-b border-border/40">
                  <span className="col-span-2">Account</span>
                  <span className="text-right">Dr / Cr</span>
                </div>
                {costs.agentCharges.map((c, idx) => {
                  const agent = sp.parentAgents.find((x) => String(x.ledger_account_id) === c.parentAgentAccountId);
                  return (
                    <div key={idx} className="grid grid-cols-3 text-xs py-0.5">
                      <span className="col-span-2 font-medium">
                        {agent?.account_name ?? "Agent Account"}{" "}
                        <Badge variant="secondary" className="text-xs ml-1">
                          Dr
                        </Badge>
                        {c.description ? <span className="text-muted-foreground ml-1">— {c.description}</span> : null}
                      </span>
                      <span className="text-right tabular-nums font-semibold">
                        {fmt2(parseFloat(c.amountUsd || "0"))}
                      </span>
                    </div>
                  );
                })}
                <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground border-t border-border/40 pt-1 mt-1">
                  <span className="col-span-2 pl-4">
                    {costs.hadiIcAcct?.name ?? "SP Test Co — Intercompany"} (Cr)
                    <Badge variant="outline" className="text-xs ml-1">
                      excluded from Net Position
                    </Badge>
                  </span>
                  <span className="text-right tabular-nums">{fmt2(costs.totalAgentCharges)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
