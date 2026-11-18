import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { LoadingState } from "@/components/ui/page-state";
import { SectionSaveBar } from "@/components/SectionSaveBar";
import { useSectionSave } from "@/hooks/use-section-save";
import type { SettingsPosReceipt } from "./settingsTypes";

const RECEIPT_OPTIONS: { key: keyof SettingsPosReceipt; label: string }[] = [
  { key: "showLogo", label: "Show Company Logo" },
  { key: "showAddress", label: "Show Address" },
  { key: "showFooter", label: "Show Footer Message" },
];

export function POSReceiptSettings() {
  const { selectedCompany } = useCompany();

  const { data: settings, isLoading } = useQuery<SettingsPosReceipt>({
    queryKey: ["/api/settings/pos-receipt", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
  });

  const section = useSectionSave<SettingsPosReceipt>({
    saved: settings || { showLogo: true, showAddress: true, showFooter: true },
    save: async (draft) => {
      await apiRequest("POST", `/api/settings/pos-receipt/${selectedCompany?.id}`, draft);
      await queryClient.invalidateQueries({ queryKey: ["/api/settings/pos-receipt", selectedCompany?.id] });
    },
    successTitle: "Receipt settings saved",
  });

  if (isLoading) return <LoadingState className="py-4" />;

  return (
    <div className="space-y-4">
      {RECEIPT_OPTIONS.map((option) => (
        <div key={option.key} className="flex items-center justify-between">
          <Label htmlFor={`pos-receipt-${option.key}`}>{option.label}</Label>
          <Switch
            id={`pos-receipt-${option.key}`}
            checked={section.draft[option.key]}
            disabled={section.isSaving}
            onCheckedChange={(value) => section.update({ [option.key]: value })}
          />
        </div>
      ))}
      <SectionSaveBar
        isDirty={section.isDirty}
        isSaving={section.isSaving}
        onSave={() => void section.save()}
        onReset={section.reset}
        data-testid="pos-receipt-save"
      />
    </div>
  );
}
