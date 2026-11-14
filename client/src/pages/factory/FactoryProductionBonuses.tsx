import { useMemo } from "react";
import { Coins } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText } from "@/i18n/factoryProductionBonusCheckoutTranslations";
import { ProductionBonusCheckoutPanel } from "./productiontargets/ProductionBonusCheckoutPanel";
import { ProductionBonusHistoryPanel } from "./productiontargets/ProductionBonusHistoryPanel";
import { localDateStr } from "./factoryProductionTargetsModel";

/** One payable workflow with immutable accounting and historical statements. */
export default function FactoryProductionBonuses() {
  const { language } = useApplicationLanguage();
  const initialDate = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get("date");
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return localDateStr(new Date());
    return Number.isFinite(Date.parse(raw + "T12:00:00Z")) &&
      new Date(raw + "T12:00:00Z").toISOString().slice(0, 10) === raw
      ? raw
      : localDateStr(new Date());
  }, []);
  return (
    <div
      className="mx-auto max-w-[1600px] space-y-5 px-2 pb-8 sm:px-4"
      data-testid="factory-production-bonus-workspace"
    >
      <PageHeader
        title={bonusText("title", language)}
        icon={<Coins className="h-5 w-5" />}
        backTarget="/factory/stock-entry?tab=production-targets"
      />
      <ProductionBonusCheckoutPanel initialDate={initialDate} />
      <details className="hidden rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
          {bonusText("paymentHistory", language)}
        </summary>
        <div className="border-t p-3">
          <ProductionBonusHistoryPanel />
        </div>
      </details>
    </div>
  );
}
