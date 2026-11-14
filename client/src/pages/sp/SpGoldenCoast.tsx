/**
 * Golden Coast operations hub.
 *
 * A thin shell: company gating, the tab bar, and a readiness refresh. Each
 * phase panel owns its own state, readiness query, and mutation, so the
 * already-approved server flows stay one file each rather than one page.
 */
import { PageHeader } from "@/components/PageHeader";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCompany } from "@/contexts/CompanyContext";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { GOLDEN_COAST_TABS, type GoldenCoastTab } from "./golden-coast/contracts";
import { FreshStartHadiPaymentPanel } from "./golden-coast/FreshStartHadiPaymentPanel";
import { EquitySalesCashPanel } from "./golden-coast/EquitySalesCashPanel";
import { GcSalesCashPanel } from "./golden-coast/GcSalesCashPanel";
import { GoldenCoastOverview } from "./golden-coast/GoldenCoastOverview";
import { HadiProceedsRemittancePanel } from "./golden-coast/HadiProceedsRemittancePanel";
import { HassanSavingsPanel } from "./golden-coast/HassanSavingsPanel";
import { MonthlyClosePanel } from "./golden-coast/MonthlyClosePanel";
import { useReadinessInvalidation } from "./golden-coast/shared";

export default function SpGoldenCoast() {
  const { selectedCompany } = useCompany();
  const [tab, setTab] = useHubQueryState<GoldenCoastTab>({
    key: "tab",
    allowedValues: GOLDEN_COAST_TABS,
    defaultValue: "overview",
    omitDefault: true,
  });
  const invalidateReadiness = useReadinessInvalidation();
  const isSupplierPartner = selectedCompany?.companyType === "supplier_partner";
  const companyKey = selectedCompany?.id ?? "no-company";

  if (!isSupplierPartner) {
    return (
      <div className="mx-auto max-w-5xl space-y-4" data-testid="sp-golden-coast">
        <PageHeader title={releaseDebtEnglish("Golden Coast operations")} />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {releaseDebtEnglish("Select a Supplier Partner company before opening Golden Coast operations.")}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6" data-testid="sp-golden-coast">
      <PageHeader
        title={releaseDebtEnglish("Golden Coast operations")}
        subtitle={releaseDebtEnglish(
          "Frontend controls for the approved Golden Coast flows. Accounting rules and account routing stay server-owned."
        )}
        meta={<Badge variant="outline">{selectedCompany?.name}</Badge>}
      >
        <Button variant="outline" size="sm" onClick={invalidateReadiness} data-testid="button-gc-refresh-readiness">
          <RefreshCw className="mr-2 h-4 w-4" />
          {releaseDebtEnglish("Refresh readiness")}
        </Button>
      </PageHeader>

      <Tabs value={tab} onValueChange={(value) => setTab(value as GoldenCoastTab)}>
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList
            className="w-max min-w-full sm:min-w-0 sm:w-fit"
            data-testid="tabs-golden-coast"
            aria-label="Golden Coast sections"
          >
            <TabsTrigger value="overview">{releaseDebtEnglish("Overview")}</TabsTrigger>
            <TabsTrigger value="hadi">{releaseDebtEnglish("HADI")}</TabsTrigger>
            <TabsTrigger value="savings">{releaseDebtEnglish("Hassan Savings")}</TabsTrigger>
            <TabsTrigger value="sales-cash">{releaseDebtEnglish("GC Sales Cash")}</TabsTrigger>
            <TabsTrigger value="monthly-close">{releaseDebtEnglish("Monthly close")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-5 space-y-5">
          <GoldenCoastOverview onOpenTab={setTab} />
        </TabsContent>

        <TabsContent value="hadi" className="mt-5 space-y-5">
          <FreshStartHadiPaymentPanel companyKey={companyKey} />
          <HadiProceedsRemittancePanel companyKey={companyKey} />
        </TabsContent>

        <TabsContent value="savings" className="mt-5">
          <HassanSavingsPanel companyKey={companyKey} />
        </TabsContent>

        <TabsContent value="sales-cash" className="mt-5 space-y-5">
          <GcSalesCashPanel companyKey={companyKey} />
          <EquitySalesCashPanel companyKey={companyKey} />
        </TabsContent>

        <TabsContent value="monthly-close" className="mt-5">
          <MonthlyClosePanel companyKey={companyKey} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
