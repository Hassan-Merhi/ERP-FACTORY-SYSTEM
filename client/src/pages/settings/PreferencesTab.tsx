import { Settings2, Check, LayoutPanelLeft } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { POSReceiptSettings } from "./POSReceiptSettings";
import { Switch } from "@/components/ui/switch";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { useToast } from "@/hooks/use-toast";

interface PreferencesTabProps {
  dateFormat: string;
  setDateFormat: (fmt: "MM/DD/YYYY" | "DD/MM/YYYY") => void;
  isDateFormatPending: boolean;
}

export function PreferencesTab({ dateFormat, setDateFormat, isDateFormatPending }: PreferencesTabProps) {
  const { prefs, updatePref, isPending: prefsPending } = useUserPreferences();
  const { toast } = useToast();

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <Settings2 className="h-5 w-5" />
          Preferences
        </h2>
        <p className="text-muted-foreground text-sm mt-1">Customize your display, floating tools, and regional settings.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Date Format</CardTitle>
          <CardDescription>Choose how dates are displayed across the application.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(["MM/DD/YYYY", "DD/MM/YYYY"] as const).map((fmt) => (
            <label
              key={fmt}
              className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors ${dateFormat === fmt ? "border-primary bg-primary/5" : "border-border hover-elevate"}`}
            >
              <input
                type="radio"
                name="dateFormat"
                value={fmt}
                checked={dateFormat === fmt}
                onChange={() => setDateFormat(fmt)}
                disabled={isDateFormatPending}
                className="accent-primary"
                data-testid={`radio-date-format-${fmt}`}
              />
              <div>
                <div className="font-medium text-sm">{fmt}</div>
                <div className="text-xs text-muted-foreground">
                  {fmt === "MM/DD/YYYY" ? "e.g. 12/31/2025 (US style)" : "e.g. 31/12/2025 (International style)"}
                </div>
              </div>
              {dateFormat === fmt && <Check className="h-4 w-4 text-primary ml-auto" />}
            </label>
          ))}
          {isDateFormatPending && <p className="text-xs text-muted-foreground">Saving…</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <LayoutPanelLeft className="h-4 w-4" />
            Floating Widgets
          </CardTitle>
          <CardDescription>
            Turn the floating AI chatbot and My Notes button on or off for your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium leading-none">Floating AI Chatbot</p>
              <p className="text-xs text-muted-foreground mt-1">
                Show or hide the AI bubble that floats over pages.
              </p>
            </div>
            <Switch
              checked={prefs?.showChatWidget !== false}
              disabled={prefsPending}
              onCheckedChange={(val) => {
                updatePref({ showChatWidget: val });
                toast({
                  title: val ? "Floating AI enabled" : "Floating AI hidden",
                  description: val
                    ? "The floating AI chatbot is now visible."
                    : "The floating AI chatbot has been hidden.",
                });
              }}
              data-testid="settings-switch-show-chat-widget"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium leading-none">My Notes</p>
              <p className="text-xs text-muted-foreground mt-1">
                Show or hide the floating notes button and panel.
              </p>
            </div>
            <Switch
              checked={prefs?.showNotesPanel !== false}
              disabled={prefsPending}
              onCheckedChange={(val) => {
                updatePref({ showNotesPanel: val });
                toast({
                  title: val ? "My Notes enabled" : "My Notes hidden",
                  description: val ? "My Notes is now visible." : "My Notes has been hidden.",
                });
              }}
              data-testid="settings-switch-show-notes-panel"
            />
          </div>
        </CardContent>
      </Card>

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
