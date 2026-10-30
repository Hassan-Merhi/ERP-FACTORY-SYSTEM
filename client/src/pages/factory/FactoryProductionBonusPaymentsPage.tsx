import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { bonusText } from "@/i18n/factoryProductionBonusCheckoutTranslations";
import { fetchProduction, localDateStr } from "./factoryProductionTargetsModel";
import { ProductionBonusCheckoutPanel } from "./productiontargets/ProductionBonusCheckoutPanel";
import { ProductionBonusHistoryPanel } from "./productiontargets/ProductionBonusHistoryPanel";

export default function FactoryProductionBonusPaymentsPage() {
  const [, navigate] = useLocation();
  const { language } = useApplicationLanguage();
  const fromUrl = new URLSearchParams(window.location.search).get("date");
  const initialDate = fromUrl && /^\d{4}-\d{2}-\d{2}$/.test(fromUrl)
    ? fromUrl : localDateStr(new Date());
  const { data } = useQuery({
    queryKey: ["/api/factory/staff-tracking", "production", "daily", initialDate, initialDate],
    queryFn: () => fetchProduction("daily", initialDate, initialDate),
  });
  return <div className="mx-auto w-full max-w-screen-2xl space-y-4 px-3 py-5 sm:px-6">
    <Button variant="outline" size="sm" onClick={() => navigate("/factory/stock-entry?tab=production-targets")}>
      <ArrowLeft className="mr-2 h-4 w-4" />{bonusText("backToTargets", language)}
    </Button>
    <ProductionBonusCheckoutPanel
      initialDate={initialDate}
      productionCategories={(data?.rows ?? []).map(row=>row.category)}
    />
    <details className="rounded-lg border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        {bonusText("paymentHistory", language)}
      </summary>
      <ProductionBonusHistoryPanel/>
    </details>
  </div>;
}
