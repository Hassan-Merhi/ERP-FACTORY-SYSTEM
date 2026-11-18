import { Settings2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { POSReceiptSettings } from "./POSReceiptSettings";
import { DateFormatSettingsCard } from "./DateFormatSettingsCard";

export function PreferencesTab() {
  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <Settings2 className="h-5 w-5" />
          Preferences
        </h2>
        <p className="text-muted-foreground text-sm mt-1">Customize your display and regional settings.</p>
      </div>
      <DateFormatSettingsCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">POS Receipt Settings</CardTitle>
          <CardDescription>Configure how POS receipts are displayed and printed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <POSReceiptSettings />
        </CardContent>
      </Card>
    </div>
  );
}
