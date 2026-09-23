import { useQuery } from "@tanstack/react-query";
import { HardHat, Shield, Users } from "lucide-react";
import FactoryWorkersHub from "@/pages/factory/FactoryWorkersHub";
import FactoryEmployeesHub from "@/pages/factory/FactoryEmployeesHub";
import FactoryInsurance from "@/pages/factory/FactoryInsurance";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateFactoryStaffTrackingText } from "@/i18n/factoryStaffTrackingTranslations";
import type { FactoryMyAccess } from "@shared/apiTypes";

type Section = "workers" | "employees" | "insurance";
const SECTIONS: Section[] = ["workers", "employees", "insurance"];
const HIDDEN_KEYS: Record<Section, string> = {
  workers: "hide_tab_payrollhub_workers",
  employees: "hide_tab_payrollhub_employees",
  insurance: "hide_tab_payrollhub_insurance",
};

export default function FactoryPayrollHub() {
  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const { language } = useApplicationLanguage();
  const tr = (key: Parameters<typeof translateFactoryStaffTrackingText>[0]) =>
    translateFactoryStaffTrackingText(key, language);
  const hidden = myAccess?.hiddenCostFields ?? [];

  const sections = SECTIONS.filter((section) => !hidden.includes(HIDDEN_KEYS[section]));
  const defaultSection: Section = sections[0] ?? "workers";
  const allowedSections: readonly Section[] = sections;

  const [activeSection, setActiveSection] = useHubQueryState<Section>({
    key: "section",
    allowedValues: allowedSections,
    knownValues: SECTIONS,
    defaultValue: defaultSection,
    clearKeys: ["tab", "mode"],
  });

  type TabDef = { key: Section; label: string; Icon: React.ElementType };
  const allTabs: TabDef[] = [
    { key: "workers", label: "Workers", Icon: HardHat },
    { key: "employees", label: "Employees", Icon: Users },
    { key: "insurance", label: "Insurance", Icon: Shield },
  ];
  const tabs = allTabs.filter((tab) => sections.includes(tab.key));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b bg-background shrink-0">
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Users className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Payroll & Benefits</h1>
            <p className="text-xs text-muted-foreground">{tr("hubDescription")}</p>
          </div>
        </div>

        <div className="flex gap-0 px-4 overflow-x-auto" role="tablist">
          {tabs.map(({ key, label, Icon }) => {
            const active = activeSection === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                data-testid={`tab-people-${key}`}
                onClick={() => setActiveSection(key)}
                className={[
                  "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {sections.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground">No Payroll & Benefits tabs are available for this user.</div>
        )}
        {activeSection === "workers" && sections.includes("workers") && (
          <div className="p-4">
            <FactoryWorkersHub />
          </div>
        )}
        {activeSection === "employees" && sections.includes("employees") && (
          <div className="p-4">
            <FactoryEmployeesHub />
          </div>
        )}
        {activeSection === "insurance" && sections.includes("insurance") && <FactoryInsurance />}
      </div>
    </div>
  );
}
