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
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

type Section = "workers" | "employees" | "insurance";
const SECTIONS: Section[] = ["workers", "employees", "insurance"];
const HIDDEN_KEYS: Record<Section, string> = {
  workers: "hide_tab_payrollhub_workers",
  employees: "hide_tab_payrollhub_employees",
  insurance: "hide_tab_payrollhub_insurance",
};

export default function FactoryPayrollHub() {
  const { selectedCompany } = useCompany();
  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id), enabled: Boolean(selectedCompany?.id), staleTime: 5 * 60000 });
  const { language } = useApplicationLanguage();
  const tr = (key: Parameters<typeof translateFactoryStaffTrackingText>[0]) =>
    translateFactoryStaffTrackingText(key, language);
  const hidden = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
    ? myAccess.hiddenCostFields
    : Object.values(HIDDEN_KEYS);

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
      <div className="relative shrink-0 overflow-hidden border-b border-blue-500/15 bg-gradient-to-br from-blue-500/10 via-background to-background dark:border-slate-700/70 dark:from-[#111f3a] dark:via-[#0c1527] dark:to-background">
        <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-32 h-72 w-[50rem] rounded-full bg-blue-500/10 blur-3xl dark:bg-blue-600/20" />
        <div aria-hidden="true" className="pointer-events-none absolute right-0 top-12 h-px w-1/2 -rotate-12 bg-gradient-to-l from-blue-400/40 via-blue-400/10 to-transparent" />
        {/* Shared page-header grammar (accent bar, icon, subtitle) like the ERP and Properties pages. */}
        <div className="relative z-10 px-4 pt-5 sm:px-6 sm:pt-6 [&>header]:mb-0 [&>header]:border-b-0 [&>header]:pb-4 [&_[data-testid=text-page-title]]:font-bold [&_[data-testid=text-page-title]]:tracking-tight [&_[data-testid=text-page-title]>span:first-child]:rounded-xl [&_[data-testid=text-page-title]>span:first-child]:border [&_[data-testid=text-page-title]>span:first-child]:border-blue-400/30 [&_[data-testid=text-page-title]>span:first-child]:bg-blue-500/15 [&_[data-testid=text-page-title]>span:first-child]:p-3 [&_[data-testid=text-page-title]>span:first-child]:text-blue-500 dark:[&_[data-testid=text-page-title]>span:first-child]:text-sky-300">
          <PageHeader
            title="Payroll & Benefits"
            subtitle={tr("hubDescription")}
            icon={<Users className="h-5 w-5" />}
            showBackButton={false}
          />
        </div>

        <div className="erp-mobile-scroll-tabs relative z-10 px-4 pb-4 sm:px-6 sm:pb-5">
          <TabsList className="w-max min-w-full gap-1.5 rounded-2xl border-blue-500/15 bg-background/70 p-1.5 shadow-lg shadow-blue-950/5 backdrop-blur-md dark:border-slate-600/60 dark:bg-slate-900/70 sm:min-w-0 sm:w-fit" aria-label="Factory sections">
            {tabs.map(({ key, label, Icon }) => {
              const active = activeSection === key;
              return (
                <PillTabButton
                  key={key}
                  selected={active}
                  className={active ? (key === "employees" ? "bg-gradient-to-r from-emerald-700 to-emerald-600 text-white shadow-md shadow-emerald-600/20 hover:text-white" : "bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-600/20 hover:text-white") : "hover:bg-blue-500/10"}
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

      <div className="min-h-0 flex-1 overflow-auto bg-gradient-to-b from-blue-500/[0.035] via-background to-background dark:from-blue-950/25 dark:via-background dark:to-background">
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
          <div className="p-4 sm:p-6">
            <FactoryEmployeesHub />
          </div>
        )}
        {activeSection === "insurance" && sections.includes("insurance") && <FactoryInsurance />}
      </div>
    </div>
  );
}
