// Extracted from ./ExcelAppearanceSettingsTab.tsx
import { useEffect, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { fetchExcelAppearance } from "@/lib/excelAppearanceClient";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getExcelAppearanceCopy } from "@/i18n/excelAppearanceTranslations";
import {
  DEFAULT_EXCEL_APPEARANCE_SETTINGS,
  excelAppearanceSettingsSchema,
  type ExcelAppearanceSettings,
} from "@shared/universal-excel/appearanceSettings";

export interface Props {
  company: { id: number; name: string } | null;
}

const MAX_LOGO_SIZE = 135_000;

const key = (id: number) => ["/api/excel-export/appearance", id];

export function useExcelAppearanceSettingsTabState({ company }: Pick<Props, "company">) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const copy = getExcelAppearanceCopy(language);
  const [draft, setDraft] = useState<ExcelAppearanceSettings>({ ...DEFAULT_EXCEL_APPEARANCE_SETTINGS });
  const [previewing, setPreviewing] = useState(false);
  const { data, isPending, error } = useQuery({
    queryKey: key(company?.id ?? 0),
    queryFn: fetchExcelAppearance,
    enabled: !!company?.id,
    staleTime: 0,
  });
  useEffect(() => {
    if (data?.appearance) setDraft(data.appearance);
  }, [data?.appearance, company?.id]);

  const save = useMutation({
    mutationFn: async (appearance: ExcelAppearanceSettings) => {
      const value = excelAppearanceSettingsSchema.parse(appearance);
      const response = await fetch("/api/excel-export/appearance", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || copy.saveError);
      }
      return (await response.json()) as { appearance: ExcelAppearanceSettings };
    },
    onSuccess: (response) => {
      setDraft(response.appearance);
      void queryClient.invalidateQueries({ queryKey: ["/api/excel-export/appearance"] });
      toast({ title: copy.saved, description: copy.savedDescription });
    },
    onError: (reason: Error) =>
      toast({
        title: copy.saveFailed,
        description: reason.message,
        variant: "destructive",
      }),
  });

  const patch = <K extends keyof ExcelAppearanceSettings>(field: K, value: ExcelAppearanceSettings[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const uploadLogo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > MAX_LOGO_SIZE) {
      toast({
        title: copy.logoUnsupported,
        description: copy.logoHint,
        variant: "destructive",
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        const candidate = { ...draft, logoDataUrl: reader.result };
        const parsed = excelAppearanceSettingsSchema.safeParse(candidate);
        if (parsed.success) patch("logoDataUrl", reader.result);
        else toast({ title: copy.logoInvalid, description: copy.logoInvalidHint, variant: "destructive" });
      }
    };
    reader.onerror = () => toast({ title: copy.logoReadFailed, variant: "destructive" });
    reader.readAsDataURL(file);
  };

  const downloadPreview = async () => {
    if (!company) return;
    try {
      const validated = excelAppearanceSettingsSchema.parse(draft);
      setPreviewing(true);
      const { downloadUniversalExcelWorkbook } = await import("@/lib/universalExcelExport");
      await downloadUniversalExcelWorkbook(
        {
          schemaVersion: 1,
          title: copy.samplePreview,
          mode: "report",
          appearance: validated,
          companyName: company.name,
          dateFormat: validated.dateFormat,
          currencyCode: "USD",
          sheets: [
            {
              kind: "table",
              name: "Sample Report",
              columns: [
                { key: "code", header: "Article Code", width: 18 },
                { key: "item", header: "Item", width: 28 },
                { key: "qty", header: "Qty", type: "integer", width: 12 },
                { key: "unit", header: "Price / Bale", type: "money", width: 18 },
                { key: "amount", header: "Total", type: "money", width: 16 },
              ],
              rows: [
                { code: "HMD10001", item: "Sample Bale", qty: 3, unit: 12.5, amount: 37.5 },
                { code: "HMD10002", item: "Sample Cotton", qty: 2, unit: 20, amount: 40 },
              ],
              footer: { code: "TOTAL", item: "", qty: 5, unit: null, amount: 77.5 },
            },
          ],
        },
        "dakzo-excel-appearance-preview.xlsx"
      );
    } catch (reason: unknown) {
      toast({
        title: copy.previewFailed,
        description: reason instanceof Error ? reason.message : copy.invalidAppearance,
        variant: "destructive",
      });
    } finally {
      setPreviewing(false);
    }
  };
  return { copy, draft, setDraft, previewing, isPending, error, save, patch, uploadLogo, downloadPreview };
}
