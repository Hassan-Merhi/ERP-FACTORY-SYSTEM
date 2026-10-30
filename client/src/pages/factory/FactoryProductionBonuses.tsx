import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Banknote, ClipboardCheck, Coins, Settings2, ShieldCheck, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProductionBonusesPanel } from "./productiontargets/ProductionBonusesPanel";
import { ProductionTargetBonusPaymentsPanel } from "./productiontargets/ProductionTargetBonusPaymentsPanel";
import { ProductionBonusHistoryPanel } from "./productiontargets/ProductionBonusHistoryPanel";
import { ProductionBonusWeeklyMethodPanel } from "./productiontargets/ProductionBonusWeeklyMethodPanel";
import { ProductionBonusWeeklyPreviewPanel } from "./productiontargets/ProductionBonusWeeklyPreviewPanel";
import { ProductionBonusCategoryRatesPanel } from "./productiontargets/ProductionBonusCategoryRatesPanel";
import { ProductionBonusCategoryEvidencePanel } from "./productiontargets/ProductionBonusCategoryEvidencePanel";
import { ProductionBonusCategoryPreviewPanel } from "./productiontargets/ProductionBonusCategoryPreviewPanel";
import { localDateStr } from "./factoryProductionTargetsModel";

type BonusTab = "setup" | "review" | "pay" | "history";
const actions: Array<{ key: BonusTab; title: string; detail: string; icon: typeof Coins }> = [
  { key: "setup", title: "1. Set up", detail: "Weekly method, category rates and evidence", icon: Settings2 },
  { key: "review", title: "2. Verify & approve", detail: "Review credited bales, targets and bonus calculations", icon: ClipboardCheck },
  { key: "pay", title: "3. Pay bonuses", detail: "Choose Cash / Bank, verify amounts and confirm payment", icon: Banknote },
  { key: "history", title: "4. History", detail: "Review posted, reversed and exported bonuses", icon: History },
];

/** Dedicated compensation workspace: no bonus configuration or money controls in the worker table. */
export default function FactoryProductionBonuses() {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(window.location.search);
  const initialDate = params.get("date")?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? localDateStr(new Date());
  const [active, setActive] = useState<BonusTab>("setup");

  return <div className="mx-auto max-w-[1600px] space-y-5 px-2 pb-8 sm:px-4" data-testid="factory-production-bonus-workspace">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-2 gap-2"
          onClick={() => navigate("/factory/stock-entry?tab=production-targets")}>
          <ArrowLeft className="h-4 w-4" /> Back to Production Targets
        </Button>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Coins className="h-6 w-6 text-primary" /> Production Bonuses
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the bonus method, verify production, approve each entitlement, then pay.
          Approval alone does not move money. Reversals keep an immutable accounting trail.
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="h-5 w-5 text-primary" />
        Admin / Owner · USD-only · audited
      </div>
    </div>

    <div role="tablist" aria-label="Production bonus workflow" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {actions.map(({ key, title, detail, icon: Icon }) => (
        <button key={key} role="tab" aria-selected={active===key}
          data-testid={`production-bonus-tab-${key}`} type="button"
          onClick={() => setActive(key)}
          className={`flex min-h-[88px] items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${active === key ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30" : "bg-card"}`}>
          <span className="rounded-lg border bg-muted/40 p-2"><Icon className="h-5 w-5" /></span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{title}</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{detail}</span>
          </span>
        </button>
      ))}
    </div>

    <section role="tabpanel" aria-label={actions.find(item=>item.key===active)?.title}
      className="space-y-4">
      {active === "setup" && <>
        <div className="rounded-lg border bg-card p-4">
          <h2 className="font-semibold">Bonus setup</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose either per-extra-bale or one fixed weekly bonus per qualifying worker.
            Configure category-specific rates for Bags, Toys, Shoes and others.
            Category-weighted amounts are currently audit/preview only, not payable;
            the daily per-extra-bale and weekly-flat approved methods are payable.
            Settings change only from their effective dates.
          </p>
        </div>
        <ProductionBonusWeeklyMethodPanel initialDate={initialDate} />
        <ProductionBonusCategoryRatesPanel initialDate={initialDate} />
        <ProductionBonusCategoryEvidencePanel initialDate={initialDate} />
      </>}
      {active === "review" && <>
        <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          Confirm the worker's credited production, assigned target, extra bales and USD amount.
          <strong className="ml-1 text-foreground">Approve</strong> locks that amount; it does not pay it.
          Open <strong className="ml-1 text-foreground">Pay bonuses</strong> when ready.
        </div>
        <ProductionBonusesPanel initialDate={initialDate} />
        <ProductionBonusWeeklyPreviewPanel initialDate={initialDate} />
        <ProductionBonusCategoryPreviewPanel initialDate={initialDate} />
      </>}
      {active === "pay" && <>
        <div className="rounded-lg border bg-card p-4 text-sm">
          <p className="font-semibold">Pay reviewed bonuses</p>
          <p className="mt-1 text-muted-foreground">
            Select Pay on an approved worker, check the frozen calculation, paying account and date,
            then confirm. This posts Payroll Deposit Expense and the matching Cash / Bank credit.
          </p>
        </div>
        <ProductionTargetBonusPaymentsPanel initialDate={initialDate} />
      </>}
      {active === "history" && <ProductionBonusHistoryPanel />}
    </section>
  </div>;
}
