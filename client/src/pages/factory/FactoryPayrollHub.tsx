import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { HardHat, Shield, Users } from "lucide-react";
import FactoryWorkersHub from "@/pages/factory/FactoryWorkersHub";
import FactoryEmployeesHub from "@/pages/factory/FactoryEmployeesHub";
import FactoryInsurance from "@/pages/factory/FactoryInsurance";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
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
      <div className="shrink-0 border-b border-border/60 bg-gradient-to-br from-background via-background to-blue-50/60 dark:to-blue-950/30">
        {/* Shared page-header grammar (accent bar, icon, subtitle) like the ERP and Properties pages. */}
        <div className="px-4 pt-4 sm:px-5 [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-3">
          <PageHeader
            title="Payroll & Benefits"
            subtitle={tr("hubDescription")}
            icon={<Users className="h-5 w-5" />}
            showBackButton={false}
          />
        </div>

        <div className="erp-mobile-scroll-tabs px-4 pb-3 sm:px-5">
          <TabsList className="w-max min-w-full rounded-2xl border-border/60 bg-muted/40 p-1 shadow-sm dark:bg-slate-900/60 sm:min-w-0 sm:w-fit" aria-label="Factory sections">
            {tabs.map(({ key, label, Icon }) => {
              const active = activeSection === key;
              return (
                <PillTabButton
                  key={key}
                  selected={active}
                  className={active ? "rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-500/20 hover:text-white dark:bg-blue-600" : "rounded-xl hover:text-foreground"}
                  data-testid={`tab-people-${key}`}
                  onClick={() => setActiveSection(key)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </PillTabButton>
              );
            })}
          </TabsList>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-background dark:bg-gradient-to-br dark:from-background dark:to-slate-950/30">
        {sections.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground">
            No Payroll & Benefits tabs are available for this user.
          </div>
        )}
        {activeSection === "workers" && sections.includes("workers") && (
          <div className="p-4 sm:p-5">
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
