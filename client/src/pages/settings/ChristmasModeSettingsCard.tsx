import { Globe2, Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useChristmasMode } from "@/hooks/useChristmasMode";

type Props = { canManage: boolean };

export function ChristmasModeSettingsCard({ canManage }: Props) {
  const { toast } = useToast();
  const { settingQuery, updateSetting } = useChristmasMode();
  const enabled = settingQuery.data?.enabled ?? false;
  const unavailable = settingQuery.isLoading || settingQuery.isError;

  return (
    <Card className="max-w-2xl" data-testid="settings-christmas-mode-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Snowflake className="h-5 w-5 text-sky-500" aria-hidden="true" />
          Christmas Mode
        </CardTitle>
        <CardDescription>
          One master switch for seasonal decorations throughout every ERP, Factory,
          Properties, Supplier Partner and Retail workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/20 p-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold">Enable Christmas decorations</p>
            <p className="text-xs text-muted-foreground">
              The switch is saved for all companies, devices and users.
            </p>
          </div>
          <Switch
            aria-label="Enable Christmas Mode for all companies"
            data-testid="settings-switch-christmas-mode"
            checked={enabled}
            disabled={!canManage || unavailable || updateSetting.isPending}
            onCheckedChange={(nextEnabled) => {
              updateSetting.mutate(nextEnabled, {
                onSuccess: () =>
                  toast({
                    title: nextEnabled ? "Christmas Mode enabled" : "Christmas Mode disabled",
                    description: "The global setting has been saved for all companies.",
                  }),
                onError: () =>
                  toast({
                    title: "Unable to save Christmas Mode",
                    description: "The setting was not changed. Please try again.",
                    variant: "destructive",
                  }),
              });
            }}
          />
        </div>
        {settingQuery.isError ? (
          <div className="flex items-center gap-3 text-sm text-destructive" role="alert">
            Could not load the global setting.
            <Button type="button" size="sm" variant="outline" onClick={() => void settingQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" role="status" data-testid="christmas-mode-status">
            {settingQuery.isLoading
              ? "Loading the global setting…"
              : enabled
                ? "Christmas Mode is ON for all companies."
                : "Christmas Mode is OFF for all companies."}
          </p>
        )}
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Globe2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            When ON, snowfall, festive header lights and subtle sidebar ornaments
            appear throughout all signed-in workspaces. A special login animation
            will be added in the next phase.
            {!canManage && " Only Admin, Owner and Developer users can change it."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
