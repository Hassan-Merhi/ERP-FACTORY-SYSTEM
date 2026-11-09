import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, DollarSign, CalendarDays, Banknote, Gift, ArrowDownCircle } from "lucide-react";
import FactoryEmployees from "@/pages/factory/FactoryEmployees";
import FactoryEmployeePayrollTab from "@/pages/factory/FactoryEmployeePayrollTab";
import FactoryEmployeeAttendanceTab from "@/pages/factory/FactoryEmployeeAttendanceTab";
import FactoryEmployeeAdvancesTab from "@/pages/factory/FactoryEmployeeAdvancesTab";
import FactoryEmployeeBonusesTab from "@/pages/factory/FactoryEmployeeBonusesTab";
import FactoryEmployeeWithdrawalsTab from "@/pages/factory/FactoryEmployeeWithdrawalsTab";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

type TabValue = "employees" | "payroll" | "attendance" | "advances" | "bonuses" | "withdrawals";

const TAB_OPTIONS: { value: TabValue; label: string; icon: React.ElementType; hiddenKey: string }[] = [
  { value: "employees", label: "Employees", icon: Users, hiddenKey: "hide_tab_employees_employees" },
  { value: "payroll", label: "Payroll", icon: DollarSign, hiddenKey: "hide_tab_employees_payroll" },
  { value: "attendance", label: "Attendance", icon: CalendarDays, hiddenKey: "hide_tab_employees_attendance" },
  { value: "advances", label: "Advances", icon: Banknote, hiddenKey: "hide_tab_employees_advances" },
  { value: "bonuses", label: "Bonuses", icon: Gift, hiddenKey: "hide_tab_employees_bonuses" },
  { value: "withdrawals", label: "Withdrawals", icon: ArrowDownCircle, hiddenKey: "hide_tab_employees_withdrawals" },
];

export default function FactoryEmployeesHub() {
  const { selectedCompany } = useCompany();
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id), enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
    ? myAccess.hiddenCostFields
    : TAB_OPTIONS.map((tab) => tab.hiddenKey);
  const visibleOptions = TAB_OPTIONS.filter((option) => !hiddenTabs.includes(option.hiddenKey));
  const visibleValues = visibleOptions.map((option) => option.value);
  const defaultValue: TabValue = visibleValues[0] ?? "employees";

  const [tab, setTab] = useHubQueryState<TabValue>({
    key: "tab",
    allowedValues: visibleValues,
    knownValues: TAB_OPTIONS.map((option) => option.value),
    defaultValue,
  });

  if (visibleOptions.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No Employee tabs are available for this user.</div>;
  }

  const effectiveTab = visibleValues.includes(tab) ? tab : defaultValue;

  return (
    <Tabs value={effectiveTab} onValueChange={(value) => setTab(value as TabValue)}>
      <div className="erp-mobile-scroll-tabs mb-4 pb-1">
        <TabsList
          className="w-max min-w-full gap-1.5 rounded-2xl border-blue-500/15 bg-card/80 p-1.5 shadow-sm backdrop-blur-sm dark:border-slate-700 dark:bg-slate-900/70 sm:min-w-0 sm:w-fit"
          aria-label="Employee sections"
          data-testid="tabs-employees-section"
        >
          {visibleOptions.map(({ value, label, icon: ItemIcon }) => (
            <TabsTrigger
              key={value}
              value={value}
              data-testid={`tab-employees-${value}`}
              className={
                effectiveTab === value
                  ? value === "employees"
                    ? "border border-emerald-400/50 bg-gradient-to-r from-emerald-700 to-emerald-600 text-white shadow-md shadow-emerald-600/20 hover:text-white"
                    : "border border-blue-400/50 bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-600/20 hover:text-white"
                  : "hover:bg-blue-500/10"
              }
            >
              <ItemIcon className="h-4 w-4 shrink-0" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {visibleValues.includes("employees") && (
        <TabsContent value="employees" className="mt-0">
          <FactoryEmployees />
        </TabsContent>
      )}
      {visibleValues.includes("payroll") && (
        <TabsContent value="payroll" className="mt-0">
          <FactoryEmployeePayrollTab />
        </TabsContent>
      )}
      {visibleValues.includes("attendance") && (
        <TabsContent value="attendance" className="mt-0">
          <FactoryEmployeeAttendanceTab />
        </TabsContent>
      )}
      {visibleValues.includes("advances") && (
        <TabsContent value="advances" className="mt-0">
          <FactoryEmployeeAdvancesTab />
        </TabsContent>
      )}
      {visibleValues.includes("bonuses") && (
        <TabsContent value="bonuses" className="mt-0">
          <FactoryEmployeeBonusesTab />
        </TabsContent>
      )}
      {visibleValues.includes("withdrawals") && (
        <TabsContent value="withdrawals" className="mt-0">
          <FactoryEmployeeWithdrawalsTab />
        </TabsContent>
      )}
    </Tabs>
  );
}
