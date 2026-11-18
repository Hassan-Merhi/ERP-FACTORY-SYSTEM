import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionSaveBar } from "@/components/SectionSaveBar";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useSectionSave } from "@/hooks/use-section-save";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { CalendarDays } from "lucide-react";

type DateFormatType = "MM/DD/YYYY" | "DD/MM/YYYY";

/**
 * The user's date format. Shared by Settings › Preferences and My Settings, so the same preference
 * has one control and one Save. It writes the same `/api/user-preferences` field as before.
 */
export function DateFormatSettingsCard() {
  const { dateFormat, isLoading } = useDateFormat();
  const { savePrefs } = useUserPreferences();
  const section = useSectionSave<{ dateFormat: DateFormatType }>({
    saved: { dateFormat },
    save: (draft) => savePrefs({ dateFormat: draft.dateFormat }),
    successTitle: "Date format saved",
  });

  return (
    <Card data-testid="date-format-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="h-4 w-4" />
          Date Format
        </CardTitle>
        <CardDescription>Choose how dates are displayed across your account.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="select-date-format">Display format</Label>
        <Select
          value={section.draft.dateFormat}
          onValueChange={(value) => section.update({ dateFormat: value as DateFormatType })}
          disabled={isLoading || section.isSaving}
        >
          <SelectTrigger id="select-date-format" data-testid="select-date-format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="MM/DD/YYYY" data-testid="option-date-format-mmddyyyy">
              MM/DD/YYYY
            </SelectItem>
            <SelectItem value="DD/MM/YYYY" data-testid="option-date-format-ddmmyyyy">
              DD/MM/YYYY
            </SelectItem>
          </SelectContent>
        </Select>
        <SectionSaveBar
          isDirty={section.isDirty}
          isSaving={section.isSaving}
          onSave={() => void section.save()}
          onReset={section.reset}
          data-testid="date-format-save"
        />
      </CardContent>
    </Card>
  );
}
