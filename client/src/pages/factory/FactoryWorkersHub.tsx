import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HardHat, DollarSign, CalendarDays, Banknote, Gift, BarChart3 } from "lucide-react";
import FactoryWorkers from "@/pages/factory/FactoryWorkers";
import FactoryPayrollTab from "@/pages/factory/FactoryPayrollTab";
import FactoryAttendance from "@/pages/factory/FactoryAttendance";
import FactoryAdvancesTab from "@/pages/factory/FactoryAdvancesTab";
import FactoryWorkerBonusesTab from "@/pages/factory/FactoryWorkerBonusesTab";
import FactoryWorkerAttendanceReport from "@/pages/factory/FactoryWorkerAttendanceReport";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { FACTORY_WORKERS_HUB_TABS } from "@/factory/config/navigationPresentation";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

type TabValue = "workers" | "payroll" | "attendance" | "report" | "advances" | "bonuses";

const ALL_TAB_OPTIONS: {
  value: TabValue;
  label: string;
  icon: React.ElementType;
  settingKey?: string;
  hiddenKey?: string;
}[] = [
  { value: "workers", label: "Workers", icon: HardHat, hiddenKey: FACTORY_WORKERS_HUB_TABS.workers },
  {
    value: "payroll",
    label: "Payroll",
    icon: DollarSign,
    settingKey: "workersTabPayrollEnabled",
    hiddenKey: FACTORY_WORKERS_HUB_TABS.payroll,
  },
  {
    value: "attendance",
    label: "Attendance",
    icon: CalendarDays,
    settingKey: "workersTabAttendanceEnabled",
    hiddenKey: FACTORY_WORKERS_HUB_TABS.attendance,
  },
  {
    value: "report",
    label: "Report",
    icon: BarChart3,
    settingKey: "workersTabReportEnabled",
    hiddenKey: FACTORY_WORKERS_HUB_TABS.report,
  },
  {
    value: "advances",
    label: "Advances",
    icon: Banknote,
    settingKey: "workersTabAdvancesEnabled",
    hiddenKey: FACTORY_WORKERS_HUB_TABS.advances,
  },
  {
    value: "bonuses",
    label: "Bonuses",
    icon: Gift,
    settingKey: "workersTabBonusesEnabled",
    hiddenKey: FACTORY_WORKERS_HUB_TABS.bonuses,
  },
];

export default function FactoryWorkersHub() {
  const { selectedCompany } = useCompany();
  const { data: settings } = useQuery({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const response = await fetch("/api/factory/settings");
      return response.ok ? response.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id), enabled: Boolean(selectedCompany?.id), staleTime: 5 * 60000 });
  const hiddenTabs = myAccess?.companyId === selectedCompany?.id && myAccess.hasFactoryAccess
    ? myAccess.hiddenCostFields
    : Object.values(FACTORY_WORKERS_HUB_TABS);

  const visibleOptions = ALL_TAB_OPTIONS.filter(({ settingKey, hiddenKey }) => {
    if (hiddenKey && hiddenTabs.includes(hiddenKey)) return false;
    if (settingKey && settings && settings[settingKey] === false) return false;
    return true;
  });
  const visibleValues = visibleOptions.map((option) => option.value);

  const [tab, setTab] = useHubQueryState<TabValue>({
    key: "tab",
    allowedValues: visibleValues,
    knownValues: ALL_TAB_OPTIONS.map((option) => option.value),
    defaultValue: visibleOptions[0]?.value ?? "workers",
    clearKeys: ["mode"],
  });

  if (visibleOptions.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No Workers tabs are available for this user.</div>;
  }

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
      <div className="erp-mobile-scroll-tabs mb-4 pb-1">
        <TabsList
          className="w-max min-w-full border-border/60 bg-muted/35 p-1.5 shadow-sm sm:min-w-0 sm:w-fit"
          aria-label="Worker sections"
          data-testid="tabs-workers-section"
        >
          {visibleOptions.map(({ value, label, icon: ItemIcon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="rounded-full px-4 data-[state=active]:bg-gradient-to-r data-[state=active]:from-blue-600 data-[state=active]:to-blue-500 data-[state=active]:text-white data-[state=active]:shadow-md"
              data-testid={`tab-workers-${value}`}
            >
              <ItemIcon className="h-4 w-4 shrink-0" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {visibleValues.includes("workers") && (
        <TabsContent value="workers" className="mt-0">
          <FactoryWorkers />
        </TabsContent>
      )}
      {visibleValues.includes("payroll") && (
        <TabsContent value="payroll" className="mt-0">
          <FactoryPayrollTab />
        </TabsContent>
      )}
      {visibleValues.includes("attendance") && (
        <TabsContent value="attendance" className="mt-0">
          <FactoryAttendance />
        </TabsContent>
      )}
      {visibleValues.includes("report") && (
        <TabsContent value="report" className="mt-0">
          <FactoryWorkerAttendanceReport />
        </TabsContent>
      )}
      {visibleValues.includes("advances") && (
        <TabsContent value="advances" className="mt-0">
          <FactoryAdvancesTab />
        </TabsContent>
      )}
      {visibleValues.includes("bonuses") && (
        <TabsContent value="bonuses" className="mt-0">
          <FactoryWorkerBonusesTab />
        </TabsContent>
      )}
    </Tabs>
  );
}
