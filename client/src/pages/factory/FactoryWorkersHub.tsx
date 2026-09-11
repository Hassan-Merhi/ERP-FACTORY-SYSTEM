import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HardHat, DollarSign, CalendarDays, Banknote, Gift, BarChart3 } from "lucide-react";
import FactoryWorkers from "@/pages/factory/FactoryWorkers";
import FactoryPayrollTab from "@/pages/factory/FactoryPayrollTab";
import FactoryAttendance from "@/pages/factory/FactoryAttendance";
import FactoryAdvancesTab from "@/pages/factory/FactoryAdvancesTab";
import FactoryWorkerBonusesTab from "@/pages/factory/FactoryWorkerBonusesTab";
import FactoryWorkerAttendanceReport from "@/pages/factory/FactoryWorkerAttendanceReport";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";

type TabValue = "workers" | "payroll" | "attendance" | "report" | "advances" | "bonuses";

const ALL_TAB_OPTIONS: {
  value: TabValue;
  label: string;
  icon: React.ElementType;
  settingKey?: string;
  hiddenKey?: string;
}[] = [
  { value: "workers", label: "Workers", icon: HardHat },
  {
    value: "payroll",
    label: "Payroll",
    icon: DollarSign,
    settingKey: "workersTabPayrollEnabled",
    hiddenKey: "hide_tab_workers_payroll",
  },
  {
    value: "attendance",
    label: "Attendance",
    icon: CalendarDays,
    settingKey: "workersTabAttendanceEnabled",
    hiddenKey: "hide_tab_workers_attendance",
  },
  {
    value: "report",
    label: "Report",
    icon: BarChart3,
    settingKey: "workersTabReportEnabled",
    hiddenKey: "hide_tab_workers_report",
  },
  {
    value: "advances",
    label: "Advances",
    icon: Banknote,
    settingKey: "workersTabAdvancesEnabled",
    hiddenKey: "hide_tab_workers_advances",
  },
  {
    value: "bonuses",
    label: "Bonuses",
    icon: Gift,
    settingKey: "workersTabBonusesEnabled",
    hiddenKey: "hide_tab_workers_bonuses",
  },
];

export default function FactoryWorkersHub() {
  const { data: settings } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const response = await fetch("/api/factory/settings");
      return response.ok ? response.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];

  const visibleOptions = ALL_TAB_OPTIONS.filter(({ settingKey, hiddenKey }) => {
    if (!settingKey) return true;
    if (settings && settings[settingKey] === false) return false;
    if (hiddenKey && hiddenTabs.includes(hiddenKey)) return false;
    return true;
  });
  const visibleValues = visibleOptions.map((option) => option.value);

  const [tab, setTab] = useHubQueryState<TabValue>({
    key: "tab",
    allowedValues: visibleValues,
    defaultValue: visibleOptions[0]?.value ?? "workers",
    clearKeys: ["mode"],
  });

  const current = visibleOptions.find((option) => option.value === tab) ?? visibleOptions[0];
  const Icon = current?.icon ?? HardHat;

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
      <div className="mb-4">
        <Select value={tab} onValueChange={(value) => setTab(value as TabValue)}>
          <SelectTrigger className="w-52" data-testid="select-workers-section">
            <SelectValue>
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" />
                {current?.label}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {visibleOptions.map(({ value, label, icon: ItemIcon }) => (
              <SelectItem key={value} value={value} data-testid={`option-workers-${value}`}>
                <span className="flex items-center gap-2">
                  <ItemIcon className="h-4 w-4 shrink-0" />
                  {label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <TabsContent value="workers" className="mt-0">
        <FactoryWorkers />
      </TabsContent>
      <TabsContent value="payroll" className="mt-0">
        <FactoryPayrollTab />
      </TabsContent>
      <TabsContent value="attendance" className="mt-0">
        <FactoryAttendance />
      </TabsContent>
      <TabsContent value="report" className="mt-0">
        <FactoryWorkerAttendanceReport />
      </TabsContent>
      <TabsContent value="advances" className="mt-0">
        <FactoryAdvancesTab />
      </TabsContent>
      <TabsContent value="bonuses" className="mt-0">
        <FactoryWorkerBonusesTab />
      </TabsContent>
    </Tabs>
  );
}
