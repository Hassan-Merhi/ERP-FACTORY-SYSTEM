import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ShoppingCart, TrendingUp, CalendarRange, Layers, ArrowLeftRight } from "lucide-react";
import { ExchangeRateSettings } from "@/components/ExchangeRateSettings";
import { FiscalPeriodTab } from "@/components/FiscalPeriodTab";
import { PriceGroupsTab } from "./PriceGroupsTab";
import { IntercompanyPosTab } from "./IntercompanyPosTab";
import { PosSettingsTab } from "./PosSettingsTab";
import { useCompany } from "@/contexts/CompanyContext";

const POS_SETUP_TABS = ["pos-settings", "exchange-rates", "fiscal", "price-groups", "intercompany"] as const;
type PosSetupTab = (typeof POS_SETUP_TABS)[number];

export function PosSetupHub({ userRole }: { userRole?: string }) {
  const { selectedCompany } = useCompany();
  const [tab, setTab] = useHubQueryState<PosSetupTab>({
    key: "tab",
    allowedValues: POS_SETUP_TABS,
    defaultValue: "pos-settings",
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <ShoppingCart className="h-5 w-5" />
          POS Setup
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Configure POS features, exchange rates, fiscal periods, price groups, and intercompany auto-transfer.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as PosSetupTab)}>
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="POS settings sections">
            <TabsTrigger value="pos-settings" className="flex items-center gap-1">
              <ShoppingCart className="h-3.5 w-3.5" />
              POS Settings
            </TabsTrigger>
            <TabsTrigger value="exchange-rates" className="flex items-center gap-1">
              <TrendingUp className="h-3.5 w-3.5" />
              Exchange Rates
            </TabsTrigger>
            <TabsTrigger value="fiscal" className="flex items-center gap-1">
              <CalendarRange className="h-3.5 w-3.5" />
              Fiscal Period
            </TabsTrigger>
            <TabsTrigger value="price-groups" className="flex items-center gap-1">
              <Layers className="h-3.5 w-3.5" />
              Price Groups
            </TabsTrigger>
            <TabsTrigger value="intercompany" className="flex items-center gap-1">
              <ArrowLeftRight className="h-3.5 w-3.5" />
              Auto-Transfer
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="pos-settings" className="mt-4">
          <PosSettingsTab />
        </TabsContent>
        <TabsContent value="exchange-rates" className="mt-4">
          <ExchangeRateSettings />
        </TabsContent>
        <TabsContent value="fiscal" className="mt-4">
          <FiscalPeriodTab currentCompanyId={selectedCompany?.id} userRole={userRole} />
        </TabsContent>
        <TabsContent value="price-groups" className="mt-4">
          <PriceGroupsTab />
        </TabsContent>
        <TabsContent value="intercompany" className="mt-4">
          <IntercompanyPosTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
