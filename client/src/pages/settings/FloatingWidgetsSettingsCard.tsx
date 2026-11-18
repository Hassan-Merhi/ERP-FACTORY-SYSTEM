import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SectionSaveBar } from "@/components/SectionSaveBar";
import { useSectionSave } from "@/hooks/use-section-save";
import { useUserPreferences, type UserPrefs } from "@/hooks/use-user-preferences";
import { LayoutPanelLeft } from "lucide-react";

type FloatingWidgetPrefs = { showChatWidget: boolean; showNotesPanel: boolean };

const WIDGETS: { key: keyof FloatingWidgetPrefs; label: string; description: string; testId: string }[] = [
  {
    key: "showChatWidget",
    label: "AI Agent Chatbot",
    description: "Show the floating AI chat bubble.",
    testId: "switch-show-chat-widget",
  },
  {
    key: "showNotesPanel",
    label: "My Notes",
    description: "Show the floating My Notes button.",
    testId: "switch-show-notes-panel",
  },
];

/**
 * Floating AI assistant and My Notes buttons, per user. Shared by Settings › Floating Widgets and
 * My Settings so the same preference has one control, one wording and one Save.
 */
export function FloatingWidgetsSettingsCard({ testIdPrefix = "" }: { testIdPrefix?: string }) {
  const { prefs, isLoading, savePrefs } = useUserPreferences();
  const saved: FloatingWidgetPrefs = {
    showChatWidget: prefs?.showChatWidget !== false,
    showNotesPanel: prefs?.showNotesPanel !== false,
  };
  const section = useSectionSave<FloatingWidgetPrefs>({
    saved,
    // Only the switches that changed are sent, as the instant switches did before.
    save: (draft) => {
      const patch: Partial<UserPrefs> = {};
      for (const { key } of WIDGETS) if (draft[key] !== saved[key]) patch[key] = draft[key];
      return savePrefs(patch);
    },
    successTitle: "Floating widgets saved",
  });

  return (
    <Card data-testid={`${testIdPrefix}floating-widgets-card`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LayoutPanelLeft className="h-4 w-4" />
          Floating Widgets
        </CardTitle>
        <CardDescription>Show or hide the floating tools that appear on every page of your account.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {WIDGETS.map((widget) => (
          <div key={widget.key} className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium leading-none">{widget.label}</p>
              <p className="text-xs text-muted-foreground mt-1">{widget.description}</p>
            </div>
            <Switch
              checked={section.draft[widget.key]}
              disabled={isLoading || section.isSaving}
              onCheckedChange={(value) => section.update({ [widget.key]: value })}
              aria-label={widget.label}
              data-testid={`${testIdPrefix}${widget.testId}`}
            />
          </div>
        ))}
        <SectionSaveBar
          isDirty={section.isDirty}
          isSaving={section.isSaving}
          onSave={() => void section.save()}
          onReset={section.reset}
          data-testid={`${testIdPrefix}floating-widgets-save`}
        />
      </CardContent>
    </Card>
  );
}
