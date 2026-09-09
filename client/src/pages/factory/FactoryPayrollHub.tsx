import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, HardHat, Shield, Target, Users } from "lucide-react";
import FactoryWorkersHub from "@/pages/factory/FactoryWorkersHub";
import FactoryEmployeesHub from "@/pages/factory/FactoryEmployeesHub";
import FactoryInsurance from "@/pages/factory/FactoryInsurance";
import FactoryProductionTargets from "@/pages/factory/FactoryProductionTargets";
import { FactoryStaffTracking } from "@/pages/factory/FactoryStaffTracking";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateFactoryStaffTrackingText } from "@/i18n/factoryStaffTrackingTranslations";
import "./factoryTrackingModern.css";

type Section = "workers" | "employees" | "production-targets" | "attendance-register" | "insurance";

export default function FactoryPayrollHub() {
  const { data: myAccess } = useQuery<any>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const { language } = useApplicationLanguage();
  const tr = (key: Parameters<typeof translateFactoryStaffTrackingText>[0]) =>
    translateFactoryStaffTrackingText(key, language);

  const hasInsuranceAccess =
    !myAccess ||
    myAccess.fullAccess ||
    !(myAccess.pageKeys?.length > 0) ||
    myAccess.pageKeys.includes("factory/insurance");

  const sections: Section[] = hasInsuranceAccess
    ? ["workers", "employees", "production-targets", "attendance-register", "insurance"]
    : ["workers", "employees", "production-targets", "attendance-register"];

  const [activeSection, setActiveSection] = useHubQueryState<Section>({
    key: "section",
    allowedValues: sections,
    defaultValue: "workers",
    clearKeys: ["tab", "mode"],
  });

  type TabDef = { key: Section; label: string; Icon: React.ElementType };
  const allTabs: TabDef[] = [
    { key: "workers", label: "Workers", Icon: HardHat },
    { key: "employees", label: "Employees", Icon: Users },
    { key: "production-targets", label: tr("productionTargets"), Icon: Target },
    { key: "attendance-register", label: tr("attendanceRegister"), Icon: ClipboardCheck },
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
        {activeSection === "workers" && (
          <div className="p-4">
            <FactoryWorkersHub />
          </div>
        )}
        {activeSection === "employees" && (
          <div className="p-4">
            <FactoryEmployeesHub />
          </div>
        )}
        {activeSection === "production-targets" && (
          <div className="factory-tracking-modern factory-tracking-production">
            <FactoryProductionTargets />
          </div>
        )}
        {activeSection === "attendance-register" && (
          <div className="factory-tracking-modern factory-tracking-attendance">
            <FactoryStaffTracking mode="attendance" />
          </div>
        )}
        {activeSection === "insurance" && hasInsuranceAccess && <FactoryInsurance />}
      </div>
    </div>
  );
}
