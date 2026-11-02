import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText } from "@/i18n/factoryProductionBonusCheckoutTranslations";
import { ProductionBonusCheckoutPanel } from "./productiontargets/ProductionBonusCheckoutPanel";
import { ProductionBonusHistoryPanel } from "./productiontargets/ProductionBonusHistoryPanel";
import { localDateStr } from "./factoryProductionTargetsModel";

/** One payable workflow with immutable accounting and historical statements. */
export default function FactoryProductionBonuses() {
  const [, navigate] = useLocation();
  const { language } = useApplicationLanguage();
  const initialDate=useMemo(()=>{
    const raw=new URLSearchParams(window.location.search).get("date");
    if(!raw||!/^\d{4}-\d{2}-\d{2}$/.test(raw))return localDateStr(new Date());
    return Number.isFinite(Date.parse(raw+"T12:00:00Z"))&&
      new Date(raw+"T12:00:00Z").toISOString().slice(0,10)===raw
      ? raw : localDateStr(new Date());
  },[]);
  return <div className="mx-auto max-w-[1600px] space-y-5 px-2 pb-8 sm:px-4"
    data-testid="factory-production-bonus-workspace">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-2 gap-2"
          onClick={()=>navigate("/factory/stock-entry?tab=production-targets")}>
          <ArrowLeft className="h-4 w-4"/>{bonusText("backToTargets",language)}
        </Button>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Coins className="h-6 w-6 text-primary"/>{bonusText("title",language)}
        </h1>
      </div>
    </div>
    <ProductionBonusCheckoutPanel initialDate={initialDate}/>
    <details className="hidden rounded-lg border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
        {bonusText("paymentHistory",language)}
      </summary>
      <div className="border-t p-3">
        <ProductionBonusHistoryPanel/>
      </div>
    </details>
  </div>;
}
