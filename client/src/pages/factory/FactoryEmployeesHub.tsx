import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PeopleHubTabStrip } from "@/pages/factory/people/PeopleHubTabStrip";
import { Users, DollarSign, CalendarDays, Banknote, Gift, ArrowDownCircle } from "lucide-react";
import FactoryEmployees from "@/pages/factory/FactoryEmployees";
import FactoryEmployeePayrollTab from "@/pages/factory/FactoryEmployeePayrollTab";
import FactoryEmployeeAttendanceTab from "@/pages/factory/FactoryEmployeeAttendanceTab";
import FactoryEmployeeAdvancesTab from "@/pages/factory/FactoryEmployeeAdvancesTab";
import FactoryEmployeeBonusesTab from "@/pages/factory/FactoryEmployeeBonusesTab";
import FactoryEmployeeWithdrawalsTab from "@/pages/factory/FactoryEmployeeWithdrawalsTab";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { RestrictedTabsState } from "@/components/RestrictedTabsState";
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
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : TAB_OPTIONS.map((tab) => tab.hiddenKey);
  const visibleOptions = TAB_OPTIONS.filter((option) => !hiddenTabs.includes(option.hiddenKey));
  const visibleValues = visibleOptions.map((option) => option.value);
  const defaultValue: TabValue = visibleValues[0] ?? "employees";

  const accessReady = myAccess?.companyId === selectedCompany?.id;
  const [tab, setTab] = useHubQueryState<TabValue>({
    key: "tab",
    // Until access loads, keep a deep-linked tab instead of stripping it.
    allowedValues: accessReady ? visibleValues : TAB_OPTIONS.map((option) => option.value),
    knownValues: TAB_OPTIONS.map((option) => option.value),
    defaultValue,
  });

  if (!accessReady) return <LoadingSkeleton variant="page" className="p-4" />;

  if (visibleOptions.length === 0) {
    return <RestrictedTabsState />;
  }

  const effectiveTab = visibleValues.includes(tab) ? tab : defaultValue;

  return (
    <Tabs value={effectiveTab} onValueChange={(value) => setTab(value as TabValue)}>
      <PeopleHubTabStrip tabs={visibleOptions} ariaLabel="Employee sections" testIdPrefix="employees" />

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
