import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, DollarSign, CalendarDays, Banknote, Gift, ArrowDownCircle } from "lucide-react";
import FactoryEmployees from "@/pages/factory/FactoryEmployees";
import FactoryEmployeePayrollTab from "@/pages/factory/FactoryEmployeePayrollTab";
import FactoryEmployeeAttendanceTab from "@/pages/factory/FactoryEmployeeAttendanceTab";
import FactoryEmployeeAdvancesTab from "@/pages/factory/FactoryEmployeeAdvancesTab";
import FactoryEmployeeBonusesTab from "@/pages/factory/FactoryEmployeeBonusesTab";
import FactoryEmployeeWithdrawalsTab from "@/pages/factory/FactoryEmployeeWithdrawalsTab";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";

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
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];
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
  const current = visibleOptions.find((option) => option.value === effectiveTab) ?? visibleOptions[0];
  const Icon = current.icon;

  return (
    <Tabs value={effectiveTab} onValueChange={(value) => setTab(value as TabValue)}>
      <div className="mb-4">
        <Select value={effectiveTab} onValueChange={(value) => setTab(value as TabValue)}>
          <SelectTrigger className="w-52" data-testid="select-employees-section">
            <SelectValue>
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" />
                {current.label}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {visibleOptions.map(({ value, label, icon: ItemIcon }) => (
              <SelectItem key={value} value={value} data-testid={`option-${value}`}>
                <span className="flex items-center gap-2">
                  <ItemIcon className="h-4 w-4 shrink-0" />
                  {label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {visibleValues.includes("employees") && <TabsContent value="employees" className="mt-0"><FactoryEmployees /></TabsContent>}
      {visibleValues.includes("payroll") && <TabsContent value="payroll" className="mt-0"><FactoryEmployeePayrollTab /></TabsContent>}
      {visibleValues.includes("attendance") && <TabsContent value="attendance" className="mt-0"><FactoryEmployeeAttendanceTab /></TabsContent>}
      {visibleValues.includes("advances") && <TabsContent value="advances" className="mt-0"><FactoryEmployeeAdvancesTab /></TabsContent>}
      {visibleValues.includes("bonuses") && <TabsContent value="bonuses" className="mt-0"><FactoryEmployeeBonusesTab /></TabsContent>}
      {visibleValues.includes("withdrawals") && <TabsContent value="withdrawals" className="mt-0"><FactoryEmployeeWithdrawalsTab /></TabsContent>}
    </Tabs>
  );
}
