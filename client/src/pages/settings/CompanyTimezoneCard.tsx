import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { SectionSaveBar } from "@/components/SectionSaveBar";
import { useSectionSave } from "@/hooks/use-section-save";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { Clock } from "lucide-react";

const TIMEZONE_OPTIONS = [
  { value: "browser", label: "Browser / Device local time" },
  { value: "UTC", label: "UTC — Coordinated Universal Time (UTC+0)" },
  { value: "Africa/Maputo", label: "Africa/Maputo (UTC+2)" },
  { value: "Africa/Lusaka", label: "Africa/Lusaka — Zambia (UTC+2)" },
  { value: "Africa/Cairo", label: "Africa/Cairo (UTC+2)" },
  { value: "Africa/Lagos", label: "Africa/Lagos (UTC+1)" },
  { value: "Africa/Nairobi", label: "Africa/Nairobi (UTC+3)" },
  { value: "Africa/Johannesburg", label: "Africa/Johannesburg (UTC+2)" },
  { value: "Asia/Beirut", label: "Asia/Beirut (UTC+2/+3)" },
  { value: "Asia/Dubai", label: "Asia/Dubai (UTC+4)" },
  { value: "Asia/Riyadh", label: "Asia/Riyadh (UTC+3)" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+5:30)" },
  { value: "Asia/Shanghai", label: "Asia/Shanghai (UTC+8)" },
  { value: "Europe/London", label: "Europe/London (UTC+0/+1)" },
  { value: "Europe/Paris", label: "Europe/Paris (UTC+1/+2)" },
  { value: "America/New_York", label: "America/New_York (UTC-5/-4)" },
  { value: "America/Chicago", label: "America/Chicago (UTC-6/-5)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (UTC-8/-7)" },
  { value: "America/Sao_Paulo", label: "America/Sao_Paulo (UTC-3)" },
  { value: "Australia/Sydney", label: "Australia/Sydney (UTC+10/+11)" },
];

/** The company's business-day timezone, shared by ERP POS Setup and Factory settings. */
export function CompanyTimezoneCard() {
  const { selectedCompany } = useCompany();
  const modeApiRequest = getApiRequest(useAppMode());

  const { data: companySettings } = useQuery({
    queryKey: ["/api/company-settings", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    queryFn: async () => {
      const res = await fetch(`/api/company-settings?companyId=${selectedCompany?.id}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  const section = useSectionSave<{ timezone: string }>({
    saved: { timezone: companySettings?.timezone || "browser" },
    save: async ({ timezone }) => {
      await modeApiRequest("POST", "/api/company-settings", {
        companyId: selectedCompany?.id,
        timezone: timezone === "browser" ? null : timezone,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/company-settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/company-settings", selectedCompany?.id] });
      // A timezone change can change today's business date immediately.
      queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates/check-today", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates/latest"] });
    },
    successTitle: "Timezone saved",
  });

  if (!selectedCompany) return null;

  return (
    <Card className="p-6">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="p-3 bg-blue-500/10 rounded-lg shrink-0">
          <Clock className="h-6 w-6 text-blue-500" />
        </div>
        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <h3 className="font-semibold" data-testid="text-company-timezone-title">
              Company Timezone
            </h3>
            <p className="text-sm text-muted-foreground">
              Fix the date used for all transactions and reports of {selectedCompany.name} to a specific timezone.
              Useful when staff computers are in a different timezone than the business location.
            </p>
          </div>
          <Select
            value={section.draft.timezone}
            onValueChange={(timezone) => section.update({ timezone })}
            disabled={section.isSaving}
          >
            <SelectTrigger className="w-full max-w-sm" data-testid="select-company-timezone">
              <SelectValue placeholder="Select timezone…" />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} data-testid={`option-timezone-${opt.value}`}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SectionSaveBar
            isDirty={section.isDirty}
            isSaving={section.isSaving}
            onSave={() => void section.save()}
            onReset={section.reset}
            data-testid="company-timezone-save"
          />
        </div>
      </div>
    </Card>
  );
}
